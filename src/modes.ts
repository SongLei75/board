/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ConnectionMode = 'direct' | 'baton' | 'jumpserver';

/** Acquisition capabilities shared by IDEs and command-line hosts. */
export function getConnectionModes(): readonly ConnectionMode[] {
	return ['direct', 'baton', 'jumpserver'];
}
