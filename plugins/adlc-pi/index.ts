// ADLC extension for pi — typed entry point.
//
// pi loads this file directly via jiti (no compile step). All behavior lives
// in ./lib/*.mjs so the unit tests exercise the same code pi runs; this shim
// only pins the typed extension contract.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "./lib/extension.mjs";

export interface Ticket {
	id: string;
	title: string;
	body: string;
	scope?: string[];
	rails?: string[];
	allowedSuppressions?: string[];
}

export default function (pi: ExtensionAPI): Promise<unknown> {
	// Return the promise so pi awaits extension setup — the native adlc_prosecute
	// tool registers (async TypeBox load) before the agent loop can call it.
	return createExtension()(pi) as Promise<unknown>;
}
