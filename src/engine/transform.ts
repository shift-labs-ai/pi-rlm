/**
 * Cell transform: TypeScript cell → sloppy-mode async body run under
 * `with (proxy)` against the persistent namespace.
 *
 * - Types are stripped with Bun.Transpiler. Dead-code elimination is disabled:
 *   it removes side-effect-free trailing expressions, which are exactly what
 *   this transform captures as the cell's result.
 * - Top-level imports become awaited dynamic imports, since the body is a
 *   function body rather than a module.
 * - Top-level declarations become plain assignments, so each binding reaches
 *   the namespace at its own statement site. Two behaviours depend on this:
 *   a closure must observe later rebinding of a name, and names bound before a
 *   cell throws or is cancelled must survive. Copying the bindings out once at
 *   the end of the cell delivers neither — that copy never runs on the paths
 *   that matter.
 * - A trailing expression statement is captured as the cell result.
 */

import type {
	ClassDeclaration,
	FunctionDeclaration,
	ImportDeclaration,
	Node,
	Pattern,
	Program,
	VariableDeclaration,
} from "acorn";
import { parse } from "acorn";

export interface TransformedCell {
	/** Body statements to run inside the async `with` wrapper. */
	body: string;
	/** Top-level names this cell binds into the namespace. */
	declaredNames: string[];
}

export interface TransformOptions {
	/** Identifier the wrapper binds the cell context to. */
	ctxName?: string;
}

// deadCodeElimination would drop side-effect-free trailing expressions — the
// exact thing we capture as the cell result.
const transpiler = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false });

function collectPatternNames(pattern: Pattern, into: string[]): void {
	switch (pattern.type) {
		case "Identifier":
			into.push(pattern.name);
			break;
		case "ObjectPattern":
			for (const prop of pattern.properties) {
				if (prop.type === "RestElement") collectPatternNames(prop.argument, into);
				else collectPatternNames(prop.value, into);
			}
			break;
		case "ArrayPattern":
			for (const element of pattern.elements) if (element) collectPatternNames(element, into);
			break;
		case "AssignmentPattern":
			collectPatternNames(pattern.left, into);
			break;
		case "RestElement":
			collectPatternNames(pattern.argument, into);
			break;
		default:
			break;
	}
}

function importReplacement(node: ImportDeclaration, ctxName: string): string {
	const moduleSpecifier = String(node.source.value);
	const moduleText = JSON.stringify(moduleSpecifier);
	const importCall = moduleSpecifier.startsWith("npm:")
		? `${ctxName}.importModule(${moduleText})`
		: `import(${moduleText})`;
	const namespaceSpecifier = node.specifiers.find((s) => s.type === "ImportNamespaceSpecifier");
	const defaultSpecifier = node.specifiers.find((s) => s.type === "ImportDefaultSpecifier");
	const namedSpecifiers = node.specifiers.filter((s) => s.type === "ImportSpecifier");

	// Assignments, not declarations: imported bindings must land in the
	// namespace so they persist across cells like any other name.
	const parts: string[] = [];
	if (namespaceSpecifier) parts.push(`${namespaceSpecifier.local.name} = await ${importCall};`);
	const destructured: string[] = [];
	if (defaultSpecifier) destructured.push(`default: ${defaultSpecifier.local.name}`);
	for (const spec of namedSpecifiers) {
		const imported = spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value);
		destructured.push(imported === spec.local.name ? imported : `${JSON.stringify(imported)}: ${spec.local.name}`);
	}
	if (destructured.length > 0) parts.push(`({ ${destructured.join(", ")} } = await ${importCall});`);
	if (parts.length === 0) parts.push(`await ${importCall};`);
	return parts.join(" ");
}

/**
 * Rewrite `let/const/var` into assignments so each binding reaches the
 * namespace as it executes. Patterns keep their shape; object patterns need
 * parentheses to stay expressions.
 */
function variableReplacement(decl: VariableDeclaration, source: string): string {
	const statements: string[] = [];
	for (const declarator of decl.declarations) {
		const target = source.slice(declarator.id.start, declarator.id.end);
		if (!declarator.init) {
			// `let x;` — bind the name so later reads resolve.
			statements.push(`${target} = undefined;`);
			continue;
		}
		const init = source.slice(declarator.init.start, declarator.init.end);
		statements.push(declarator.id.type === "ObjectPattern" ? `(${target} = ${init});` : `${target} = ${init};`);
	}
	return statements.join(" ");
}

export function transformCell(code: string, options: TransformOptions = {}): TransformedCell {
	const ctxName = options.ctxName ?? "__ctx";
	const js = transpiler.transformSync(code);
	const program: Program = parse(js, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });

	const declaredNames: string[] = [];
	const replacements: { start: number; end: number; text: string }[] = [];
	const topLevel = program.body;

	for (const node of topLevel) {
		switch (node.type) {
			case "ImportDeclaration": {
				const decl = node as ImportDeclaration;
				for (const spec of decl.specifiers) declaredNames.push(spec.local.name);
				replacements.push({ start: decl.start, end: decl.end, text: importReplacement(decl, ctxName) });
				break;
			}
			case "ExportNamedDeclaration":
			case "ExportDefaultDeclaration":
			case "ExportAllDeclaration":
				throw new SyntaxError("export statements are not supported in cells");
			case "VariableDeclaration": {
				const decl = node as VariableDeclaration;
				for (const declarator of decl.declarations) collectPatternNames(declarator.id, declaredNames);
				replacements.push({ start: decl.start, end: decl.end, text: variableReplacement(decl, js) });
				break;
			}
			case "FunctionDeclaration":
			case "ClassDeclaration": {
				const decl = node as FunctionDeclaration | ClassDeclaration;
				if (!decl.id) break;
				declaredNames.push(decl.id.name);
				// A named function/class expression keeps self-reference (recursion)
				// while making the binding proxy-backed and failure-surviving.
				const sourceText = js.slice(decl.start, decl.end);
				replacements.push({ start: decl.start, end: decl.end, text: `${decl.id.name} = ${sourceText};` });
				break;
			}
			default:
				break;
		}
	}

	// Capture a trailing expression statement as the cell result.
	const last = topLevel[topLevel.length - 1] as Node | undefined;
	if (last && last.type === "ExpressionStatement") {
		const expression = (last as unknown as { expression: Node }).expression;
		const expressionText = js.slice(expression.start, expression.end);
		replacements.push({ start: last.start, end: last.end, text: `${ctxName}.setResult((${expressionText}));` });
	}

	replacements.sort((a, b) => a.start - b.start);
	let body = "";
	let cursor = 0;
	for (const replacement of replacements) {
		body += js.slice(cursor, replacement.start) + replacement.text;
		cursor = replacement.end;
	}
	body += js.slice(cursor);

	return { body, declaredNames: [...new Set(declaredNames)] };
}
