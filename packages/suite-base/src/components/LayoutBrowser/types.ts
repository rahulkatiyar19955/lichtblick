// SPDX-FileCopyrightText: Copyright (C) 2023-2024 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { Layout } from "@lichtblick/suite-base/services/ILayoutStorage";

export type MultiAction = "delete" | "duplicate" | "revert" | "save";

export type LayoutSelectionState = {
  busy: boolean;
  error: undefined | Error;
  online: boolean;
  lastSelectedId: undefined | string;
  multiAction: undefined | { action: MultiAction; ids: string[] };
  selectedIds: string[];
};

export type LayoutSelectionAction =
  | { type: "clear-multi-action" }
  | { type: "queue-multi-action"; action: MultiAction }
  | {
      type: "select-id";
      id?: string;
      layouts?: undefined | { personal: Layout[]; shared: Layout[] };
      shiftKey?: boolean;
      modKey?: boolean;
    }
  | { type: "set-busy"; value: boolean }
  | { type: "set-error"; value: undefined | Error }
  | { type: "set-online"; value: boolean }
  | { type: "shift-multi-action" };
