// SPDX-FileCopyrightText: Copyright (C) 2023-2025 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { Autocomplete, TextField } from "@mui/material";
import { produce } from "immer";
import * as _ from "lodash-es";
import { useCallback, useEffect, useMemo } from "react";

import { compare } from "@lichtblick/rostime";
import { SettingsTreeAction } from "@lichtblick/suite";
import { useDataSourceInfo } from "@lichtblick/suite-base/PanelAPI";
import EmptyState from "@lichtblick/suite-base/components/EmptyState";
import { usePanelContext } from "@lichtblick/suite-base/components/PanelContext";
import PanelToolbar from "@lichtblick/suite-base/components/PanelToolbar";
import Stack from "@lichtblick/suite-base/components/Stack";
import { useStyles } from "@lichtblick/suite-base/panels/DiagnosticStatus/DiagnosticStatusPanel.style";
import useAvailableDiagnostics from "@lichtblick/suite-base/panels/DiagnosticStatus/hooks/useAvailableDiagnostics";
import { DiagnosticStatusPanelProps } from "@lichtblick/suite-base/panels/DiagnosticStatus/types";
import { getDisplayName } from "@lichtblick/suite-base/panels/DiagnosticStatus/utils/getDisplayName";
import {
  ALLOWED_DATATYPES,
  DEFAULT_SECONDS_UNTIL_STALE,
  LEVELS,
} from "@lichtblick/suite-base/panels/DiagnosticSummary/constants";
import useDiagnostics from "@lichtblick/suite-base/panels/DiagnosticSummary/hooks/useDiagnostics";
import useStaleTime from "@lichtblick/suite-base/panels/DiagnosticSummary/hooks/useStaleTime";
import { usePanelSettingsTreeUpdate } from "@lichtblick/suite-base/providers/PanelStateContextProvider";

import DiagnosticTable from "./DiagnosticTable";
import { buildStatusPanelSettingsTree } from "./utils/buildStatusPanelSettingsTree";

// component to display a single diagnostic status from list
const DiagnosticStatusPanel = (props: DiagnosticStatusPanelProps): React.JSX.Element => {
  const { saveConfig, config } = props;
  const { topics } = useDataSourceInfo();
  const { openSiblingPanel } = usePanelContext();
  const {
    selectedHardwareId,
    selectedName,
    splitFraction,
    topicToRender,
    numericPrecision,
    secondsUntilStale = DEFAULT_SECONDS_UNTIL_STALE,
  } = config;
  const { classes } = useStyles();

  const staleTime = useStaleTime(secondsUntilStale);

  const updatePanelSettingsTree = usePanelSettingsTreeUpdate();

  // Filter down all topics to those that conform to our supported datatypes
  const availableTopics = useMemo(() => {
    const filtered = topics
      .filter(
        (topic) => topic.schemaName != undefined && ALLOWED_DATATYPES.includes(topic.schemaName),
      )
      .map((topic) => topic.name);

    // Keeps only the first occurrence of each topic.
    return _.uniq([...filtered]);
  }, [topics]);

  // If the topicToRender is not in the availableTopics, then we should not try to use it
  const diagnosticTopic = useMemo(() => {
    return availableTopics.includes(topicToRender) ? topicToRender : undefined;
  }, [availableTopics, topicToRender]);

  const diagnostics = useDiagnostics(diagnosticTopic);
  const availableDiagnostics = useAvailableDiagnostics(diagnosticTopic);

  // generate Autocomplete entries from the available diagnostics
  const autocompleteOptions = useMemo(() => {
    const items = [];

    for (const [hardwareId, nameSet] of availableDiagnostics) {
      if (hardwareId) {
        items.push({ label: hardwareId, hardwareId, name: undefined });
      }

      for (const name of nameSet) {
        if (name) {
          const label = getDisplayName(hardwareId, name);
          items.push({ label, hardwareId, name });
        }
      }
    }

    return items;
  }, [availableDiagnostics]);

  const selectedDisplayName = useMemo(() => {
    return selectedHardwareId != undefined
      ? getDisplayName(selectedHardwareId, selectedName ?? "")
      : undefined;
  }, [selectedHardwareId, selectedName]);

  const selectedAutocompleteOption = useMemo(() => {
    return (
      autocompleteOptions.find((item) => {
        return item.label === selectedDisplayName;
      }) ?? ReactNull
    );
  }, [autocompleteOptions, selectedDisplayName]);

  const filteredDiagnostics = useMemo(() => {
    const diagnosticsByName = diagnostics.get(selectedHardwareId ?? "");
    const items = [];

    if (diagnosticsByName != undefined) {
      for (const diagnostic of diagnosticsByName.values()) {
        if (selectedName == undefined || selectedName === diagnostic.status.name) {
          const markStale = staleTime != undefined && compare(diagnostic.stamp, staleTime) < 0;
          if (markStale) {
            items.push({ ...diagnostic, status: { ...diagnostic.status, level: LEVELS.STALE } });
          } else {
            items.push(diagnostic);
          }
        }
      }
    }

    return items;
  }, [diagnostics, selectedHardwareId, selectedName, staleTime]);

  // If there are available options but none match the user input we show a No matches
  // but if we don't have any options at all then we show waiting for diagnostics...
  const noOptionsText = autocompleteOptions.length > 0 ? "No matches" : "Waiting for diagnostics…";

  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action !== "update") {
        return;
      }

      const { path, value } = action.payload;
      saveConfig(produce((draft) => _.set(draft, path.slice(1), value)));
    },
    [saveConfig],
  );

  useEffect(() => {
    updatePanelSettingsTree({
      actionHandler,
      nodes: buildStatusPanelSettingsTree(config, topicToRender, availableTopics),
    });
  }, [actionHandler, config, availableTopics, topicToRender, updatePanelSettingsTree]);

  function renderEmptyState(displayName: string | undefined): React.JSX.Element {
    return displayName ? (
      <EmptyState>
        Waiting for diagnostics from <code>{displayName}</code>
      </EmptyState>
    ) : (
      <EmptyState>No diagnostic node selected</EmptyState>
    );
  }

  return (
    <Stack flex="auto" overflow="hidden">
      <PanelToolbar className={classes.toolbar}>
        <Autocomplete
          disablePortal
          blurOnSelect={true}
          disabled={autocompleteOptions.length === 0}
          options={autocompleteOptions}
          value={selectedAutocompleteOption ?? ReactNull}
          noOptionsText={noOptionsText}
          onChange={(_ev, value) => {
            if (!value) {
              saveConfig({
                selectedHardwareId: undefined,
                selectedName: undefined,
              });
              return;
            }

            saveConfig({
              selectedHardwareId: value.hardwareId,
              selectedName: value.name,
            });
          }}
          fullWidth
          size="small"
          renderInput={(params) => (
            <TextField
              variant="standard"
              {...params}
              InputProps={{ ...params.InputProps, disableUnderline: true }}
              placeholder={selectedDisplayName ?? "Filter"}
            />
          )}
        />
      </PanelToolbar>
      {filteredDiagnostics.length > 0 ? (
        <Stack flex="auto" overflowY="auto" testId="filtered-diagnostics">
          {_.sortBy(filteredDiagnostics, ({ status }) => status.name.toLowerCase()).map((item) => (
            <DiagnosticTable
              key={item.id}
              info={item}
              splitFraction={splitFraction}
              onChangeSplitFraction={(newSplitFraction) => {
                props.saveConfig({ splitFraction: newSplitFraction });
              }}
              topicToRender={topicToRender}
              numericPrecision={numericPrecision}
              openSiblingPanel={openSiblingPanel}
            />
          ))}
        </Stack>
      ) : (
        renderEmptyState(selectedDisplayName)
      )}
    </Stack>
  );
};

export default DiagnosticStatusPanel;
