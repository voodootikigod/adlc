import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface Ticket {
	id: string;
	title: string;
	body: string;
	scope?: string[];
	rails?: string[];
}

export default function (pi: ExtensionAPI) {
	let activeTicketId: string | undefined;
	let activeTicket: Ticket | undefined;
	const suppressionsList = [
		"@ts-ignore",
		"@ts-expect-error",
		"eslint-disable",
		"eslint-disable-next-line",
		".skip(",
		".only(",
		"xfail",
		"# noqa",
		"#[ignore]",
	];

	// =========================================================================
	// 1. Core State & Ticket Loader
	// =========================================================================

	function loadActiveTicket(cwd: string) {
		const envTicket = process.env.ADLC_TICKET;
		let fileTicket: string | undefined;

		try {
			const currentPath = path.join(cwd, ".adlc", "current-ticket.json");
			if (fs.existsSync(currentPath)) {
				const current = JSON.parse(fs.readFileSync(currentPath, "utf-8"));
				fileTicket = current.id ?? current.ticket ?? current.ticketId;
			}
		} catch (e) {
			// Silently fail or log
		}

		activeTicketId = envTicket ?? fileTicket;
		if (!activeTicketId) return;

		try {
			const ticketsPath = process.env.ADLC_TICKETS ?? path.join(cwd, ".adlc", "tickets.json");
			if (fs.existsSync(ticketsPath)) {
				const data = JSON.parse(fs.readFileSync(ticketsPath, "utf-8"));
				const tickets = data.tickets || [];
				activeTicket = tickets.find((t: Ticket) => t.id === activeTicketId);
			}
		} catch (e) {
			// Silently fail or log
		}
	}

	// Glob match helper (* and ** support)
	function globMatch(pattern: string, filePath: string): boolean {
		const regex = new RegExp(
			"^" +
				pattern
					.split(/(\*\*\/|\*\*|\*)/)
					.map((part) => {
						if (part === "**/") return "(?:.*/)?";
						if (part === "**") return ".*";
						if (part === "*") return "[^/]*";
						return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
					})
					.join("") +
				"$"
		);
		return regex.test(filePath);
	}

	function isPathBlocked(filePath: string): boolean {
		if (!activeTicket || !activeTicket.rails) return false;
		const normalized = filePath.replace(/\\/g, "/");
		return activeTicket.rails.some((rail) => globMatch(rail, normalized));
	}

	// Simple shell parser to extract literal paths/files targeted by mutated commands
	function collectShellPaths(text: string): string[] {
		const out = new Set<string>();

		// Capture redirections (e.g., > output.txt, >> append.txt)
		const redirectPattern = /(?:^|[\s])(?:>>?|[0-9]>>?|[0-9]>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
		let redirect;
		while ((redirect = redirectPattern.exec(text)) !== null) {
			out.add(redirect[1] ?? redirect[2] ?? redirect[3]);
		}

		// Capture quoted paths (e.g., "src/foo.ts", 'test/bar.ts')
		const quotedPathPattern = /["'`]([^"'`\n]*[/\\][^"'`\n]*)["'`]/g;
		let quoted;
		while ((quoted = quotedPathPattern.exec(text)) !== null) {
			out.add(quoted[1]);
		}

		// Split tokens to look for files
		const tokens = text.split(/\s+/);
		for (const token of tokens) {
			if (!token.startsWith("-") && !token.includes("=") && (token.includes("/") || token.includes("."))) {
				out.add(token);
			}
		}

		return Array.from(out);
	}

	// Check if a shell command contains mutations
	function shellHasMutation(text: string): boolean {
		return (
			/(^|[\s;&|])(?:>>?|[0-9]>>?|[0-9]>)\s*\S+/.test(text) ||
			/\b(tee|touch|rm|mv|cp|install|dd|truncate|rsync)\b/.test(text) ||
			/\b(sed|perl|awk)\b/.test(text) ||
			/\b(writeFile|appendFile|rmSync|renameSync|copyFile|truncateSync|mkdirSync|write_text|write_bytes)\b/.test(text)
		);
	}

	// =========================================================================
	// 2. Lifecycle Handlers
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		loadActiveTicket(ctx.cwd);
		if (activeTicketId) {
			ctx.ui.setStatus("adlc-ticket", `🎟️ Ticket: \x1b[33m${activeTicketId}\x1b[0m`);
			ctx.ui.notify(`ADLC Session Active: Ticket ${activeTicketId} loaded.`, "info");
		}
	});

	// Append ADLC guidelines & ticket context directly to System Prompt (Defends F3/F1)
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!activeTicket) return {};

		const scopeStr = activeTicket.scope?.join(", ") || "No restrictions";
		const railsStr = activeTicket.rails?.join(", ") || "None declared";

		return {
			systemPrompt: `

=== ADLC DOCTRINE & TICKET SPECIFICATION ===
You are executing a bounded task under the Agentic Development Lifecycle (ADLC).
ACTIVE TICKET ID: ${activeTicket.id}
TICKET TITLE: ${activeTicket.title}

[BOUNDED SCOPE]
Allowed File Scopes: ${scopeStr}
You must ONLY edit files matching these scope patterns. Out-of-scope modifications will result in immediate rejection.

[FROZEN RAILS]
Frozen Test/Contract Rails: ${railsStr}
You are STRICTLY FORBIDDEN from editing or deleting files matching these patterns. Do not modify tests or lower assertions to make things pass. If a test is wrong, declare the ticket blocked.

[ADLC RULES]
1. Evidence or it didn't happen: Never state a result you did not verify by execution. Run tests, compilers, or linters and quote the actual outputs in your turns.
2. Completion protocol: When all gates pass, verify them one final time and terminate your session response with exactly: TICKET-DONE
3. Blocking: If you encounter contradictory requirements or a broken rail, end with: TICKET-BLOCKED: <reason>
`,
		};
	});

	// Proactive Gating in tool_call (P4 Rail Guard)
	pi.on("tool_call", async (event, ctx) => {
		if (!activeTicket) return undefined;

		// Intercept direct file modifications
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = event.input.path as string;
			if (isPathBlocked(filePath)) {
				ctx.ui.notify(`Blocked direct edit to frozen rail: ${filePath}`, "error");
				return { block: true, reason: `Blocked edit: "${filePath}" matches frozen rail glob in ticket ${activeTicketId}` };
			}
		}

		// Intercept shell mutations matching frozen rails
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (shellHasMutation(command)) {
				const paths = collectShellPaths(command);
				const blocked = paths.filter((p) => isPathBlocked(p));
				if (blocked.length > 0) {
					ctx.ui.notify(`Blocked shell mutation editing frozen rails: ${blocked.join(", ")}`, "error");
					return {
						block: true,
						reason: `Blocked command: edits frozen rails (${blocked.join(", ")}) in ticket ${activeTicketId}`,
					};
				}
			}
		}

		return undefined;
	});

	// Reactive Gating in tool_result (P3/P4 Suppression Marker Gate)
	pi.on("tool_result", async (event, ctx) => {
		if (!activeTicket) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") {
			return undefined;
		}

		// Fetch workspace diff to inspect newly added lines
		try {
			const { stdout: diffText } = await pi.exec("git", ["diff", "HEAD"]);
			if (!diffText.trim()) return undefined;

			// Parse added lines in the diff
			const violations: Array<{ file: string; lineNo: number; marker: string; content: string }> = [];
			let currentFile = "";
			let lineCount = 0;

			for (const line of diffText.split(/\r?\n/)) {
				if (line.startsWith("+++ b/")) {
					currentFile = line.slice(6).trim();
					lineCount = 0;
					continue;
				}
				if (line.startsWith("@@")) {
					// Extract starting line number (e.g., @@ -10,4 +10,6 @@)
					const match = line.match(/\+(\d+)/);
					if (match) lineCount = parseInt(match[1], 10) - 1;
					continue;
				}
				if (line.startsWith("+") && !line.startsWith("+++")) {
					lineCount++;
					const addedContent = line.slice(1);
					for (const marker of suppressionsList) {
						if (addedContent.includes(marker)) {
							// Check if this marker is allowed in the ticket body (e.g., "allow-suppression: @ts-ignore")
							const allowedStr = `allow-suppression: ${marker}`;
							if (!activeTicket.body.includes(allowedStr)) {
								violations.push({
									file: currentFile,
									lineNo: lineCount,
									marker,
									content: addedContent.trim(),
								});
							}
						}
					}
				} else if (!line.startsWith("-")) {
					lineCount++;
				}
			}

			if (violations.length > 0) {
				ctx.ui.notify(`Blocked unallowed suppression marker: ${violations[0].marker}`, "error");

				// Revert violating files to preserve frozen rail integrity
				const uniqueFiles = Array.from(new Set(violations.map((v) => v.file)));
				for (const f of uniqueFiles) {
					await pi.exec("git", ["checkout", "--", f]);
				}

				// Override tool result with error, sending feedback to LLM
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `GATE FAILED: You introduced unallowed suppression markers. The following changes have been automatically REVERTED:\n${violations
								.map((v) => `- ${v.file}:${v.lineNo} -> introduced marker "${v.marker}" in "${v.content}"`)
								.join("\n")}\nTo use this marker, request authorization in the ticket body via: "allow-suppression: ${violations[0].marker}"`,
						},
					],
				};
			}
		} catch (e) {
			// Git error or diff parsing error
		}

		return undefined;
	});

	// =========================================================================
	// 3. User Commands & Interactions
	// =========================================================================

	pi.registerCommand("ticket", {
		description: "Display the active ADLC ticket and scope constraints",
		async handler(ctx) {
			loadActiveTicket(ctx.cwd);

			if (!activeTicketId) {
				ctx.ui.notify("No active ADLC ticket resolved. Use process.env.ADLC_TICKET or .adlc/current-ticket.json", "warning");
				return;
			}

			if (!activeTicket) {
				ctx.ui.notify(`Ticket ${activeTicketId} not found in tickets.json`, "error");
				return;
			}

			ctx.ui.notify(`Active Ticket: ${activeTicket.id}`, "info");
			console.log(`\n\x1b[1mTicket ${activeTicket.id}: ${activeTicket.title}\x1b[0m`);
			console.log(`Scope: ${activeTicket.scope?.join(", ") || "No restrictions"}`);
			console.log(`Rails: ${activeTicket.rails?.join(", ") || "None declared"}`);
			console.log(`\n\x1b[2mBody:\x1b[0m\n${activeTicket.body}\n`);
		},
	});
}
