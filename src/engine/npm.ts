/**
 * Lazy npm: specifier support for cells.
 *
 * Bun's plugin hooks do not intercept ordinary runtime imports in a preloaded
 * script, so the cell transform calls importNpm() for static npm: imports.
 * Packages are installed into a per-specifier cache, then loaded by absolute
 * file URL so Bun handles the package's own dependency graph normally.
 */

import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const cacheRoot =
	process.env.PI_RLM_NPM_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-rlm-npm");
const pending = new Map<string, Promise<string>>();
const INSTALL_LOCK_TIMEOUT_MS = 120_000;

interface ParsedSpecifier {
	name: string;
	version: string;
	subpath: string;
}

function parseSpecifier(specifier: string): ParsedSpecifier {
	if (!specifier.startsWith("npm:")) {
		throw new Error(`Expected an npm: specifier, received ${specifier}`);
	}
	const raw = specifier.slice("npm:".length);
	const match = /^(@[^/]+\/[^@/]+|[^@/]+)(?:@([^/]+))?(\/.*)?$/.exec(raw);
	if (!match) {
		throw new Error(`Unsupported npm specifier: ${specifier}. Use npm:package@version.`);
	}

	const name = match[1];
	const version = match[2] ?? "latest";
	const subpath = match[3] ?? "";
	const nameParts = name.startsWith("@") ? name.slice(1).split("/") : [name];
	if (
		(name.startsWith("@") && nameParts.length !== 2) ||
		(!name.startsWith("@") && nameParts.length !== 1) ||
		nameParts.some((part) => !/^[a-zA-Z0-9._~-]+$/.test(part))
	) {
		throw new Error(`Invalid npm package name: ${name}`);
	}
	if (version.includes(String.fromCharCode(92)) || version.includes(String.fromCharCode(0))) {
		throw new Error(`Invalid npm package version: ${version}`);
	}
	return { name, version, subpath };
}

function cacheKey(name: string, version: string): string {
	const digest = createHash("sha256").update(`${name}@${version}`).digest("hex").slice(0, 20);
	const readable = `${name}@${version}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return `${readable}-${digest}`;
}

async function exists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

async function readJson(path: string): Promise<any> {
	return JSON.parse(await Bun.file(path).text());
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withInstallLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for npm cache install lock: ${lockPath}`);
			}
			await sleep(50);
		}
	}

	try {
		return await action();
	} finally {
		await rm(lockPath, { recursive: true, force: true }).catch(() => {});
	}
}

async function installPackage(name: string, version: string): Promise<string> {
	const installRoot = join(cacheRoot, cacheKey(name, version));
	const packageDir = join(installRoot, "node_modules", name);
	const packageJson = join(installRoot, "package.json");
	await mkdir(installRoot, { recursive: true });

	const hasPackage = async (): Promise<boolean> => await exists(join(packageDir, "package.json"));
	if (await hasPackage()) return packageDir;

	await withInstallLock(`${installRoot}.install-lock`, async () => {
		if (await hasPackage()) return;
		await Bun.write(
			packageJson,
			`${JSON.stringify(
				{
					name: "pi-rlm-npm-cache",
					private: true,
					dependencies: { [name]: version },
				},
				null,
				2,
			)}\n`,
		);

		const child = Bun.spawn(["bun", "install", "--no-progress"], {
			cwd: installRoot,
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
		const exitCode = await child.exited;
		if (exitCode !== 0) {
			throw new Error(`Could not install ${name}@${version}:\n${await stderrPromise}`);
		}
		await stderrPromise;
	});

	if (!(await hasPackage())) {
		throw new Error(`Bun install completed without installing ${name}@${version}`);
	}
	return packageDir;
}

function pickExportTarget(value: any, wildcard?: string): string | undefined {
	if (typeof value === "string") return wildcard === undefined ? value : value.replaceAll("*", wildcard);
	if (Array.isArray(value)) {
		for (const item of value) {
			const selected = pickExportTarget(item, wildcard);
			if (selected) return selected;
		}
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;

	for (const condition of ["bun", "import", "node", "default"]) {
		if (condition in value) {
			const selected = pickExportTarget(value[condition], wildcard);
			if (selected) return selected;
		}
	}
	return undefined;
}

function isSubpathMap(value: any): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).some((key) => key.startsWith(".")),
	);
}

function exportTarget(exportsMap: any, key: string): string | undefined {
	if (!isSubpathMap(exportsMap)) return key === "." ? pickExportTarget(exportsMap) : undefined;
	if (key in exportsMap) return pickExportTarget(exportsMap[key]);

	for (const [pattern, value] of Object.entries(exportsMap)) {
		if (!pattern.endsWith("/*")) continue;
		const prefix = pattern.slice(0, -1);
		if (key.startsWith(prefix)) return pickExportTarget(value, key.slice(prefix.length));
	}
	return undefined;
}

async function resolveEntry(packageDir: string, subpath: string): Promise<string> {
	const manifest = await readJson(join(packageDir, "package.json"));
	let target: string | undefined;
	const key = subpath ? `.${subpath}` : ".";

	if (manifest.exports !== undefined) {
		target = exportTarget(manifest.exports, key);
		if (!target) {
			throw new Error(`Package ${manifest.name ?? packageDir} does not export ${key}`);
		}
	} else if (subpath) {
		target = subpath.slice(1);
	} else {
		target = manifest.module ?? manifest.main ?? "index.js";
	}

	if (!target) {
		throw new Error(`Package ${manifest.name ?? packageDir} has no entry point`);
	}
	if (manifest.exports !== undefined && !target.startsWith("./")) {
		throw new Error(`Unsupported package entry ${target} in ${manifest.name ?? packageDir}`);
	}
	if (!target.startsWith("./")) {
		while (target.startsWith("/")) target = target.slice(1);
		target = `./${target}`;
	}
	const entry = resolve(packageDir, target);
	const packageRelative = relative(packageDir, entry);
	if (
		!packageRelative ||
		isAbsolute(packageRelative) ||
		packageRelative === ".." ||
		packageRelative.startsWith(`..${sep}`)
	) {
		throw new Error(`Package entry escapes its package directory: ${target}`);
	}

	for (const candidate of [
		entry,
		`${entry}.js`,
		`${entry}.mjs`,
		`${entry}.cjs`,
		`${entry}.json`,
		join(entry, "index.js"),
	]) {
		if (await exists(candidate)) return candidate;
	}
	throw new Error(`Package entry does not exist: ${entry}`);
}

async function ensurePackage(name: string, version: string): Promise<string> {
	const key = `${name}@${version}`;
	const existing = pending.get(key);
	if (existing) return await existing;
	const task = installPackage(name, version);
	pending.set(key, task);
	return await task;
}

export async function importNpm(specifier: string): Promise<unknown> {
	const parsed = parseSpecifier(specifier);
	const packageDir = await ensurePackage(parsed.name, parsed.version);
	const entry = await resolveEntry(packageDir, parsed.subpath);
	return await import(pathToFileURL(entry).href);
}
