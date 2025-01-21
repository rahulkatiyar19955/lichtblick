// SPDX-FileCopyrightText: Copyright (C) 2023-2024 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import { nanoid } from "nanoid";
import React, { PropsWithChildren, useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { StoreApi, createStore } from "zustand";

import Logger from "@lichtblick/log";
import {
  ExtensionContext,
  ExtensionModule,
  PanelSettings,
  RegisterMessageConverterArgs,
  TopicAliasFunction,
} from "@lichtblick/suite";
import {
  ExtensionCatalog,
  ExtensionCatalogContext,
  InstallExtensionsResponse,
  RegisteredPanel,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { TopicAliasFunctions } from "@lichtblick/suite-base/players/TopicAliasingPlayer/aliasing";
import { ExtensionLoader } from "@lichtblick/suite-base/services/ExtensionLoader";
import { ExtensionInfo, ExtensionNamespace } from "@lichtblick/suite-base/types/Extensions";

const log = Logger.getLogger(__filename);

type MessageConverter = RegisterMessageConverterArgs<unknown> & {
  extensionNamespace?: ExtensionNamespace;
};

type ContributionPoints = {
  panels: Record<string, RegisteredPanel>;
  messageConverters: MessageConverter[];
  topicAliasFunctions: TopicAliasFunctions;
  panelSettings: Record<string, Record<string, PanelSettings<unknown>>>;
};

const REFRESH_EXTENSIONS_BATCH = 5;
const INSTALL_EXTENSIONS_BATCH = 5;

function activateExtension(
  extension: ExtensionInfo,
  unwrappedExtensionSource: string,
): ContributionPoints {
  // registered panels stored by their fully qualified id
  // the fully qualified id is the extension name + panel name
  const panels: Record<string, RegisteredPanel> = {};

  const messageConverters: RegisterMessageConverterArgs<unknown>[] = [];

  const panelSettings: Record<string, Record<string, PanelSettings<unknown>>> = {};

  const topicAliasFunctions: ContributionPoints["topicAliasFunctions"] = [];

  log.debug(`Activating extension ${extension.qualifiedName}`);

  const module = { exports: {} };
  const require = (name: string) => {
    return { react: React, "react-dom": ReactDOM }[name];
  };

  const extensionMode =
    process.env.NODE_ENV === "production"
      ? "production"
      : process.env.NODE_ENV === "test"
        ? "test"
        : "development";

  const ctx: ExtensionContext = {
    mode: extensionMode,

    registerPanel: (params) => {
      log.debug(`Extension ${extension.qualifiedName} registering panel: ${params.name}`);

      const fullId = `${extension.qualifiedName}.${params.name}`;
      if (panels[fullId]) {
        log.warn(`Panel ${fullId} is already registered`);
        return;
      }

      panels[fullId] = {
        extensionName: extension.qualifiedName,
        extensionNamespace: extension.namespace,
        registration: params,
      };
    },

    registerMessageConverter: <Src,>(args: RegisterMessageConverterArgs<Src>) => {
      log.debug(
        `Extension ${extension.qualifiedName} registering message converter from: ${args.fromSchemaName} to: ${args.toSchemaName}`,
      );
      messageConverters.push({
        ...args,
        extensionNamespace: extension.namespace,
      } as MessageConverter);

      const converterSettings = _.mapValues(args.panelSettings, (settings) => ({
        [args.fromSchemaName]: settings,
      }));

      _.merge(panelSettings, converterSettings);
    },

    registerTopicAliases: (aliasFunction: TopicAliasFunction) => {
      topicAliasFunctions.push({ aliasFunction, extensionId: extension.id });
    },
  };

  try {
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    const fn = new Function("module", "require", unwrappedExtensionSource);

    // load the extension module exports
    fn(module, require, {});
    const wrappedExtensionModule = module.exports as ExtensionModule;

    wrappedExtensionModule.activate(ctx);
  } catch (err: unknown) {
    log.error(err);
  }

  return {
    panels,
    messageConverters,
    topicAliasFunctions,
    panelSettings,
  };
}
function createExtensionRegistryStore(
  loaders: readonly ExtensionLoader[],
  mockMessageConverters: readonly RegisterMessageConverterArgs<unknown>[] | undefined,
): StoreApi<ExtensionCatalog> {
  return createStore((set, get) => ({
    loadedExtensions: new Set<string>(),
    isExtensionLoaded: (extensionId: string) => {
      return get().loadedExtensions.has(extensionId);
    },
    markExtensionAsLoaded: (extensionId: string) => {
      const updatedExtensions = new Set(get().loadedExtensions);
      updatedExtensions.add(extensionId);
      set({ loadedExtensions: updatedExtensions });
    },
    unmarkExtensionAsLoaded: (extensionId: string) => {
      const updatedExtensions = new Set(get().loadedExtensions);
      updatedExtensions.delete(extensionId);
      set({ loadedExtensions: updatedExtensions });
    },
    downloadExtension: async (url: string) => {
      const res = await fetch(url);
      return new Uint8Array(await res.arrayBuffer());
    },

    installExtension: async (namespace: ExtensionNamespace, data: Uint8Array) => {
      const namespacedLoader = loaders.find((loader) => loader.namespace === namespace);
      if (namespacedLoader == undefined) {
        throw new Error("No extension loader found for namespace " + namespace);
      }
      const info = await namespacedLoader.installExtension(data);
      return info;
    },
    installExtensions: async (namespace: ExtensionNamespace, data: Uint8Array[]) => {
      const namespacedLoader = loaders.find((loader) => loader.namespace === namespace);
      if (namespacedLoader == undefined) {
        throw new Error("No extension loader found for namespace " + namespace);
      }

      const batchPromises = async (batch: Uint8Array[]): Promise<InstallExtensionsResponse[]> => {
        return await Promise.all(
          batch.map(async (extension: Uint8Array) => {
            try {
              const info = await namespacedLoader.installExtension(extension);
              get().unmarkExtensionAsLoaded(info.id);
              return { success: true, info };
            } catch (error) {
              return { success: false, error };
            }
          }),
        );
      };

      const results: InstallExtensionsResponse[] = [];
      for (let i = 0; i < data.length; i += INSTALL_EXTENSIONS_BATCH) {
        const chunk = data.slice(i, i + INSTALL_EXTENSIONS_BATCH);
        const batchResults = await batchPromises(chunk);
        results.push(...batchResults);
      }
      return results;
    },
    refreshAllExtensions: async () => {
      if (loaders.length === 0) {
        return;
      }

      const start = performance.now();
      const extensionList: ExtensionInfo[] = [];
      const allContributionPoints: ContributionPoints = {
        panels: {},
        messageConverters: [],
        topicAliasFunctions: [],
        panelSettings: {},
      };

      const processExtensionsBatch = async (
        extensionsBatch: ExtensionInfo[],
        loader: ExtensionLoader,
      ) => {
        await Promise.all(
          extensionsBatch.map(async (extension) => {
            try {
              extensionList.push(extension);
              const nano = nanoid();
              console.time(`GOLD_${nano}--loadExtension-${extension.displayName}`);
              const unwrappedExtensionSource = await loader.loadExtension(extension.id);
              console.timeEnd(`GOLD_${nano}--loadExtension-${extension.displayName}`);

              const contributionPoints = activateExtension(extension, unwrappedExtensionSource);
              _.assign(allContributionPoints.panels, contributionPoints.panels);
              _.merge(allContributionPoints.panelSettings, contributionPoints.panelSettings);
              allContributionPoints.messageConverters.push(...contributionPoints.messageConverters);
              allContributionPoints.topicAliasFunctions.push(
                ...contributionPoints.topicAliasFunctions,
              );
              get().markExtensionAsLoaded(extension.id);
            } catch (err: unknown) {
              log.error(`Error loading extension ${extension.id}`, err);
            }
          }),
        );
      };

      const processLoader = async (loader: ExtensionLoader) => {
        try {
          const nano = nanoid();
          console.time(`GOLD_${nano}--getExtensions`);
          const extensions = await loader.getExtensions();
          console.timeEnd(`GOLD_${nano}--getExtensions`);

          const chunks = _.chunk(extensions, REFRESH_EXTENSIONS_BATCH);
          console.log("GOLD chunks", chunks);
          for (const chunk of chunks) {
            await processExtensionsBatch(chunk, loader);
          }
        } catch (err: unknown) {
          log.error("Error loading extension list", err);
        }
      };

      await Promise.all(loaders.map(processLoader));

      log.info(
        `GOLD Loaded ${extensionList.length} extensions in ${(performance.now() - start).toFixed(1)}ms`,
      );

      set({
        installedExtensions: extensionList,
        installedPanels: allContributionPoints.panels,
        installedMessageConverters: allContributionPoints.messageConverters,
        installedTopicAliasFunctions: allContributionPoints.topicAliasFunctions,
        panelSettings: allContributionPoints.panelSettings,
      });
    },
    refreshExtensions: async () => {
      if (loaders.length === 0) {
        return;
      }

      const start = performance.now();
      const extensionList: ExtensionInfo[] = [];
      const allContributionPoints: ContributionPoints = {
        panels: {},
        messageConverters: [],
        topicAliasFunctions: [],
        panelSettings: {},
      };

      const processExtensionsBatch = async (
        extensionsBatch: ExtensionInfo[],
        loader: ExtensionLoader,
      ) => {
        await Promise.all(
          extensionsBatch.map(async (extension) => {
            try {
              if (get().isExtensionLoaded(extension.id)) {
                return;
              }

              extensionList.push(extension);

              const nano = nanoid();
              console.time(`GOLD_${nano}--loadExtension-${extension.displayName}`);
              const unwrappedExtensionSource = await loader.loadExtension(extension.id);
              console.timeEnd(`GOLD_${nano}--loadExtension-${extension.displayName}`);

              const contributionPoints = activateExtension(extension, unwrappedExtensionSource);
              _.assign(allContributionPoints.panels, contributionPoints.panels);
              _.merge(allContributionPoints.panelSettings, contributionPoints.panelSettings);
              allContributionPoints.messageConverters.push(...contributionPoints.messageConverters);
              allContributionPoints.topicAliasFunctions.push(
                ...contributionPoints.topicAliasFunctions,
              );

              get().markExtensionAsLoaded(extension.id);
            } catch (err: unknown) {
              log.error(`Error loading extension ${extension.id}`, err);
            }
          }),
        );
      };

      await Promise.all(
        loaders.map(async (loader) => {
          const extensions = await loader.getExtensions();
          const chunks = _.chunk(extensions, REFRESH_EXTENSIONS_BATCH);
          for (const chunk of chunks) {
            await processExtensionsBatch(chunk, loader);
          }
        }),
      );

      log.info(
        `GOLD Incrementally loaded ${extensionList.length} extensions in ${(performance.now() - start).toFixed(1)}ms`,
      );

      set({
        installedExtensions: extensionList,
        installedPanels: allContributionPoints.panels,
        installedMessageConverters: allContributionPoints.messageConverters,
        installedTopicAliasFunctions: allContributionPoints.topicAliasFunctions,
        panelSettings: allContributionPoints.panelSettings,
      });
    },

    // If there are no loaders then we know there will not be any installed extensions
    installedExtensions: loaders.length === 0 ? [] : undefined,

    installedPanels: {},

    installedMessageConverters: mockMessageConverters ?? [],

    installedTopicAliasFunctions: [],

    panelSettings: _.merge(
      {},
      ...(mockMessageConverters ?? []).map(({ fromSchemaName, panelSettings }) =>
        _.mapValues(panelSettings, (settings) => ({ [fromSchemaName]: settings })),
      ),
    ),

    uninstallExtension: async (namespace: ExtensionNamespace, id: string) => {
      const namespacedLoader = loaders.find((loader) => loader.namespace === namespace);
      if (namespacedLoader == undefined) {
        throw new Error("No extension loader found for namespace " + namespace);
      }
      await namespacedLoader.uninstallExtension(id);
      get().unmarkExtensionAsLoaded(id);
      await get().refreshExtensions();
    },
  }));
}

export default function ExtensionCatalogProvider({
  children,
  loaders,
  mockMessageConverters,
}: PropsWithChildren<{
  loaders: readonly ExtensionLoader[];
  mockMessageConverters?: readonly RegisterMessageConverterArgs<unknown>[];
}>): React.JSX.Element {
  const [store] = useState(createExtensionRegistryStore(loaders, mockMessageConverters));

  // Request an initial refresh on first mount
  const refreshAllExtensions = store.getState().refreshAllExtensions;
  useEffect(() => {
    refreshAllExtensions().catch((err: unknown) => {
      log.error(err);
    });
  }, [refreshAllExtensions]);

  return (
    <ExtensionCatalogContext.Provider value={store}>{children}</ExtensionCatalogContext.Provider>
  );
}
