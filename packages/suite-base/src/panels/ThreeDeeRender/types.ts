// SPDX-FileCopyrightText: Copyright (C) 2023-2025 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { DeepPartial } from "ts-essentials";

import { CameraModelsMap } from "@lichtblick/den/image/types";
import { BuiltinPanelExtensionContext } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import { FollowMode, TestOptions } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";
import { SceneExtensionConfig } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtensionConfig";
import { CameraState } from "@lichtblick/suite-base/panels/ThreeDeeRender/camera";

export type InterfaceMode = "3d" | "image";

export type Shared3DPanelState = {
  cameraState: CameraState;
  followMode: FollowMode;
  followTf: undefined | string;
};

export type ThreeDeeRenderProps = {
  context: BuiltinPanelExtensionContext;
  interfaceMode: InterfaceMode;
  testOptions: TestOptions;
  /** Allow for injection or overriding of default extensions by custom extensions */
  customSceneExtensions?: DeepPartial<SceneExtensionConfig>;
  customCameraModels: CameraModelsMap;
};
