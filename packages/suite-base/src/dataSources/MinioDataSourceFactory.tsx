// SPDX-FileCopyrightText: Copyright (C) 2023-2025 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import path from "path";

import { AllowedFileExtensions } from "@lichtblick/suite-base/constants/allowedFileExtensions";
import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@lichtblick/suite-base/context/PlayerSelectionContext";
import { IterablePlayer } from "@lichtblick/suite-base/players/IterablePlayer";
import { WorkerSerializedIterableSource } from "@lichtblick/suite-base/players/IterablePlayer/WorkerSerializedIterableSource";
import { Player } from "@lichtblick/suite-base/players/types";

const initWorkers: Record<string, () => Worker> = {
  ".bag": () => {
    return new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL(
        "@lichtblick/suite-base/players/IterablePlayer/BagIterableSourceWorker.worker",
        import.meta.url,
      ),
    );
  },
  ".mcap": () => {
    return new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL(
        "@lichtblick/suite-base/players/IterablePlayer/Mcap/McapIterableSourceWorker.worker",
        import.meta.url,
      ),
    );
  },
};

const fileTypesAllowed: AllowedFileExtensions[] = [
  AllowedFileExtensions.BAG,
  AllowedFileExtensions.MCAP,
];

/**
 * Extract filename from Content-Disposition header
 * Examples:
 * - attachment; filename="rosbag.bag"
 * - attachment; filename*=UTF-8''rosbag.bag
 */
function extractFilenameFromContentDisposition(header: string): string | undefined {
  // Try quoted filename first: filename="example.bag"
  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  // Try unquoted filename: filename=example.bag
  const unquotedMatch = header.match(/filename=([^\s;]+)/i);
  if (unquotedMatch?.[1]) {
    return unquotedMatch[1];
  }

  // Try RFC 5987 encoded filename: filename*=UTF-8''example.bag
  const encodedMatch = header.match(/filename\*=(?:UTF-8''|utf-8'')([^\s;]+)/i);
  if (encodedMatch?.[1]) {
    return decodeURIComponent(encodedMatch[1]);
  }

  return undefined;
}

/**
 * Extract extension from presigned URL's response-content-disposition parameter
 * Synchronous version - no HEAD request fallback
 */
function getExtensionFromUrl(url: string): string | undefined {
  // First, try to extract from URL query parameter (response-content-disposition)
  try {
    const urlObj = new URL(url);
    const contentDisposition = urlObj.searchParams.get("response-content-disposition");
    if (contentDisposition) {
      const filename = extractFilenameFromContentDisposition(decodeURIComponent(contentDisposition));
      if (filename) {
        const ext = path.extname(filename);
        if (ext) {
          return ext;
        }
      }
    }
  } catch {
    // URL parsing failed
  }

  // Fallback: Try to get extension from URL path
  try {
    const urlObj = new URL(url);
    const pathExtension = path.extname(urlObj.pathname);
    if (pathExtension && fileTypesAllowed.includes(pathExtension as AllowedFileExtensions)) {
      return pathExtension;
    }
  } catch {
    // URL parsing failed
  }

  return undefined;
}

class MinioDataSourceFactory implements IDataSourceFactory {
  public id = "minio";

  public type: IDataSourceFactory["type"] = "connection";
  public displayName = "MinIO/S3 File";
  public iconName: IDataSourceFactory["iconName"] = "FileASPX";
  public supportedFileTypes = fileTypesAllowed;
  public description = "Open .bag or .mcap files from MinIO/S3 presigned URLs.";
  public docsLinks = [
    {
      label: "MinIO",
      url: "https://min.io/docs/minio/linux/reference/minio-mc.html",
    },
  ];

  public formConfig = {
    fields: [
      {
        id: "url",
        label: "Presigned URL",
        placeholder: "https://minio.example.com/bucket/key?X-Amz-...",
        validate: (newValue: string): Error | undefined => {
          try {
            new URL(newValue);
            return undefined;
          } catch {
            return new Error("Enter a valid URL");
          }
        },
      },
    ],
  };

  public warning = "Loading large files over HTTP can be slow";

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    if (args.params?.url == undefined) {
      return;
    }

    const url = args.params.url;
    
    // Get extension from Content-Disposition or URL (synchronous)
    const extension = getExtensionFromUrl(url) || ".bag"; // Default to .bag if detection fails

    const initWorker = initWorkers[extension];
    if (!initWorker) {
      console.warn(`MinioDataSourceFactory: Unsupported extension ${extension}, unsupported file type.`);
      throw new Error(`Unsupported file extension: ${extension}. Supported extensions: .bag, .mcap`);
    }

    const source = new WorkerSerializedIterableSource({ initWorker, initArgs: { url } });

    return new IterablePlayer({
      source,
      name: url,
      metricsCollector: args.metricsCollector,
      urlParams: { url },
      sourceId: this.id,
      readAheadDuration: { sec: 10, nsec: 0 },
    });
  }
}

export default MinioDataSourceFactory;
