import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	borrowPrivateBasedpyright,
	checkIdleClients,
	ensureWorkspaceFolders,
	getOrCreateClient,
	isIdleClient,
	sendRequest,
	shutdownClientInstance,
} from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { LspClient } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { isFileLockHeld } from "@oh-my-pi/pi-utils";

const IDLE_TIMEOUT_MS = 60_000;

/**
 * Minimal in-memory LSP client. `stdin` is a sink so `sendRequest` can register
 * a pending request without a real server process; nothing ever answers, so the
 * request stays in flight until the test settles it by hand. The rest of `proc`
 * mirrors the shape the other hand-built clients in this repo use, so any
 * teardown path that runs is looking at a whole process, not a hole.
 */
function makeClient(): LspClient {
	return {
		name: "test-lsp",
		cwd: process.cwd(),
		config: { command: "test-lsp", fileTypes: [".ts"], rootMarkers: [] },
		proc: {
			exited: new Promise<number>(() => {}),
			exitCode: null,
			stdin: {
				write(chunk: string | Uint8Array) {
					return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
				},
				flush: () => 0,
			},
			stdout: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill() {},
		} as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		publishedDiagnostics: new Map(),
		pulledDiagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

/**
 * Settle a pending request the way the message reader does: it removes the
 * entry from `pendingRequests` *before* invoking the stored resolver, so the
 * map drains on the reader's side, not inside the resolver.
 */
function settle(client: LspClient, id: number, outcome: { value: unknown } | { error: Error }): void {
	const entry = client.pendingRequests.get(id);
	if (!entry) throw new Error(`no pending request with id ${id}`);
	client.pendingRequests.delete(id);
	if ("error" in outcome) entry.reject(outcome.error);
	else entry.resolve(outcome.value);
}

describe("idle checker (#8390)", () => {
	it("never reports a client with an in-flight request as idle", async () => {
		const client = makeClient();
		const pending = sendRequest(client, "textDocument/hover", {}, undefined, 10 * IDLE_TIMEOUT_MS);
		// One clock read drives both the client's timestamp and every sweep below.
		// Re-reading `Date.now()` per assertion would make the margins depend on
		// how long the test itself took, which a loaded CI runner does not bound.
		const now = Date.now();
		// The request was *sent* long ago and is still outstanding: exactly the
		// shape that used to be torn down mid-flight.
		client.lastActivity = now - 10 * IDLE_TIMEOUT_MS;

		expect(client.pendingRequests.size).toBe(1);

		// Control: the previous checker was `now - lastActivity > timeoutMs` with
		// no in-flight check, so this exact client was reapable — the request
		// below would have been rejected with "LSP client shutdown" mid-flight.
		// Keep both assertions together so a regression that drops the guard
		// fails loudly instead of silently agreeing with the old behaviour.
		expect(now - client.lastActivity > IDLE_TIMEOUT_MS).toBe(true);
		expect(isIdleClient(client, now, IDLE_TIMEOUT_MS)).toBe(false);
		// Not even an arbitrarily distant sweep may reap it while work is in flight.
		expect(isIdleClient(client, now + 24 * 60 * 60_000, IDLE_TIMEOUT_MS)).toBe(false);

		settle(client, 1, { value: { contents: "ok" } });
		await expect(pending).resolves.toEqual({ contents: "ok" });
	});

	it("reports a quiet client as idle once the window elapses", () => {
		const client = makeClient();
		const now = Date.now();
		client.lastActivity = now - 10 * IDLE_TIMEOUT_MS;

		expect(client.pendingRequests.size).toBe(0);
		expect(isIdleClient(client, now, IDLE_TIMEOUT_MS)).toBe(true);
	});

	it("keeps a client below the idle window alive", () => {
		const client = makeClient();
		// Both the stamp and the sweep come from one clock read: the boundary
		// case is exactly `IDLE_TIMEOUT_MS - 1`, so even 2ms of scheduling drift
		// between two `Date.now()` calls would push the sweep past the window and
		// flip this assertion on a busy runner.
		const now = Date.now();
		client.lastActivity = now;

		expect(isIdleClient(client, now + IDLE_TIMEOUT_MS - 1, IDLE_TIMEOUT_MS)).toBe(false);
		// The far side of the same boundary, from the same clock read.
		expect(isIdleClient(client, now + IDLE_TIMEOUT_MS + 1, IDLE_TIMEOUT_MS)).toBe(true);
	});

	it("refreshes lastActivity when a request settles so a fresh answer is not reaped", async () => {
		const client = makeClient();
		const pending = sendRequest(client, "textDocument/hover", {}, undefined, 10 * IDLE_TIMEOUT_MS);
		const sentAt = Date.now() - 10 * IDLE_TIMEOUT_MS;
		client.lastActivity = sentAt;

		settle(client, 1, { value: { contents: "ok" } });
		await expect(pending).resolves.toEqual({ contents: "ok" });

		// The map has drained, so the pending-request guard no longer applies —
		// only the refreshed timestamp stands between a just-answered client and
		// the next sweep.
		expect(client.pendingRequests.size).toBe(0);
		expect(client.lastActivity).toBeGreaterThan(sentAt);
		expect(isIdleClient(client, Date.now(), IDLE_TIMEOUT_MS)).toBe(false);
		// It does become eligible again once the full window passes with no work.
		expect(isIdleClient(client, client.lastActivity + IDLE_TIMEOUT_MS + 1, IDLE_TIMEOUT_MS)).toBe(true);
	});

	it("refreshes lastActivity when a request settles with an error", async () => {
		const client = makeClient();
		const pending = sendRequest(client, "textDocument/hover", {}, undefined, 10 * IDLE_TIMEOUT_MS);
		const sentAt = Date.now() - 10 * IDLE_TIMEOUT_MS;
		client.lastActivity = sentAt;

		settle(client, 1, { error: new Error("LSP error -32601: Unknown request") });
		await expect(pending).rejects.toThrow(/-32601/);

		expect(client.pendingRequests.size).toBe(0);
		expect(client.lastActivity).toBeGreaterThan(sentAt);
		expect(isIdleClient(client, Date.now(), IDLE_TIMEOUT_MS)).toBe(false);
	});
});

const nativeFixture = `
import { appendFileSync, existsSync } from "node:fs";
const [transcript, release] = process.argv.slice(2);
let buffer = Buffer.alloc(0);
const send = message => {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
for await (const chunk of process.stdin) {
	buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	while (true) {
		const header = buffer.indexOf("\\r\\n\\r\\n");
		if (header < 0) break;
		const length = Number(buffer.subarray(0, header).toString().split(":")[1]);
		if (buffer.length < header + 4 + length) break;
		const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
		buffer = buffer.subarray(header + 4 + length);
		appendFileSync(transcript, JSON.stringify({ pid: process.pid, ...message }) + "\\n");
		if (message.method === "initialize") {
			send({ id: message.id, result: { capabilities: { referencesProvider: true } } });
		} else if (message.method === "fixture/finishAnalysis") {
			send({ method: "$/progress", params: { token: "analysis", value: { kind: "begin", title: "" } } });
			send({ method: "$/progress", params: { token: "analysis", value: { kind: "end" } } });
			send({ id: message.id, result: null });
		} else if (message.method === "shutdown") {
			send({ id: message.id, result: null });
		} else if (message.method === "exit") {
			if (existsSync(release + ".block")) {
				const child = Bun.spawn([process.execPath, "-e", \`
					const release = process.argv[1];
					const deadline = Date.now() + 4000;
					while (!(await Bun.file(release).exists()) && Date.now() < deadline) await Bun.sleep(10);
					await Bun.write(release + ".done", "exited by protocol fixture");
				\`, release], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
				child.unref();
			}
			process.exit(0);
		}
	}
}
`;

async function withNativeFixture(
	run: (
		workspace: string,
		config: LspClient["config"],
		lock: string,
		transcript: string,
		release: string,
	) => Promise<void>,
): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-private-lsp-")));
	const workspace = path.join(root, ".worktrees", "a");
	await fs.mkdir(workspace, { recursive: true });
	const file = path.join(root, "langserver.ts");
	const transcript = path.join(root, "transcript.jsonl");
	const release = path.join(root, "release");
	const lock = path.join(root, "cold-start");
	await Bun.write(file, nativeFixture);
	const priorRoot = process.env.OMP_PRIVATE_BASEDPYRIGHT_ROOT;
	const priorLock = process.env.OMP_PRIVATE_BASEDPYRIGHT_LOCK;
	process.env.OMP_PRIVATE_BASEDPYRIGHT_ROOT = workspace;
	process.env.OMP_PRIVATE_BASEDPYRIGHT_LOCK = lock;
	try {
		await run(
			workspace,
			{
				command: "basedpyright-langserver",
				resolvedCommand: process.execPath,
				args: [file, transcript, release],
				fileTypes: [".py"],
				rootMarkers: [],
			},
			lock,
			transcript,
			release,
		);
	} finally {
		await Bun.write(release, "");
		if (priorRoot === undefined) delete process.env.OMP_PRIVATE_BASEDPYRIGHT_ROOT;
		else process.env.OMP_PRIVATE_BASEDPYRIGHT_ROOT = priorRoot;
		if (priorLock === undefined) delete process.env.OMP_PRIVATE_BASEDPYRIGHT_LOCK;
		else process.env.OMP_PRIVATE_BASEDPYRIGHT_LOCK = priorLock;
		await fs.rm(root, { recursive: true, force: true });
	}
}

const macTest = it.skipIf(process.platform !== "darwin");

macTest("holds the cold lease across operations and reopens on demand", async () => {
	await withNativeFixture(async (workspace, config, lock, transcript) => {
		const client = await getOrCreateClient(config, workspace);
		try {
			expect(isFileLockHeld(lock)).toBe(true);
			{
				using _borrow = borrowPrivateBasedpyright(workspace);
				await sendRequest(client, "fixture/finishAnalysis", {});
				await client.projectLoaded;
				expect(isFileLockHeld(lock)).toBe(true);
				client.lastActivity = Date.now() - 180_000;
				await checkIdleClients();
				expect(client.proc.exitCode).toBeNull();
			}
			expect(isFileLockHeld(lock)).toBe(false);
			await expect(ensureWorkspaceFolders(client, [transcript])).rejects.toThrow("outside its workspace");
			client.lastActivity = Date.now() - 180_000;
			await checkIdleClients();
			expect(client.proc.exitCode).toBe(0);
			const replacement = await getOrCreateClient(config, workspace);
			try {
				expect(replacement.proc.pid).not.toBe(client.proc.pid);
				const events = (await Bun.file(transcript).text())
					.trim()
					.split("\n")
					.map(line => JSON.parse(line));
				expect(events.map(row => row.method)).toContain("exit");
				for (const row of events.filter(row => row.method === "initialize")) {
					expect(row.params.rootPath).toBe(workspace);
					expect(row.params.workspaceFolders).toHaveLength(1);
				}
			} finally {
				await shutdownClientInstance(replacement);
			}
		} finally {
			await shutdownClientInstance(client);
		}
	});
});

macTest(
	"does not replace a server with a surviving worker",
	async () => {
		await withNativeFixture(async (workspace, config, lock, _transcript, release) => {
			await Bun.write(release + ".block", "");
			const client = await getOrCreateClient(config, workspace);
			try {
				expect(await shutdownClientInstance(client)).toBe(false);
				expect(client.proc.exitCode).toBe(0);
				expect(isFileLockHeld(lock)).toBe(true);
				await expect(getOrCreateClient(config, workspace)).rejects.toThrow("has not released");
			} finally {
				await Bun.write(release, "");
				// The orphan is an OS process, so fake timers cannot observe its actual exit.
				const deadline = Date.now() + 3000;
				while (isFileLockHeld(lock) && Date.now() < deadline) {
					await Bun.sleep(20);
					// Re-observe the same group, never signal or start a second one.
					await shutdownClientInstance(client);
				}
			}
			expect(await Bun.file(release + ".done").text()).toBe("exited by protocol fixture");
			expect(isFileLockHeld(lock)).toBe(false);
		});
	},
	7000,
);
