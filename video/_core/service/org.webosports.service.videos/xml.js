/* xml.js - a small, forgiving XML reader for UPnP device descriptions, SOAP replies and DIDL-Lite.
 *
 *   const doc = parse(text)            -> { name: "#document", children: [...] }
 *   el.name     "dc:title" (as written), el.local "title" (the prefix taken off)
 *   el.attrs    { id: "64", ... } (prefixes kept, values decoded)
 *   el.children elements and text nodes ({ text })
 *   find(el, "title"), findAll(el, "item"), childText(el, "title"), textOf(el)
 *
 * Names are matched by their local part, as the servers use every prefix there is (or none) for the
 * same namespace. No DTDs, no external entities: <!DOCTYPE> and <!ENTITY> are skipped, so a reply
 * cannot make the reader fetch or expand anything. A document that ends early gives what was read;
 * a stray "<" is taken as text.
 */
"use strict";

const NAMED = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decode(s) {
	return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			if (!isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) { return all; }
			return String.fromCodePoint(n);
		}
		const v = NAMED[e.toLowerCase()];
		return v === undefined ? all : v;
	});
}

const localName = (name) => { const i = name.indexOf(":"); return i >= 0 ? name.slice(i + 1) : name; };

function parseAttrs(s) {
	const attrs = {};
	const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
	let m;
	while ((m = re.exec(s)) !== null) {
		attrs[m[1]] = decode(m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]));
	}
	return attrs;
}

function parse(input) {
	const src = String(input || "");
	const root = { name: "#document", local: "#document", attrs: {}, children: [] };
	const stack = [root];
	let i = 0;
	const top = () => stack[stack.length - 1];
	const addText = (t) => { if (t) { top().children.push({ text: decode(t) }); } };
	while (i < src.length) {
		const lt = src.indexOf("<", i);
		if (lt < 0) { addText(src.slice(i)); break; }
		if (lt > i) { addText(src.slice(i, lt)); }
		if (src.startsWith("<!--", lt)) {
			const end = src.indexOf("-->", lt + 4);
			i = end < 0 ? src.length : end + 3;
			continue;
		}
		if (src.startsWith("<![CDATA[", lt)) {
			const end = src.indexOf("]]>", lt + 9);
			top().children.push({ text: src.slice(lt + 9, end < 0 ? src.length : end) });
			i = end < 0 ? src.length : end + 3;
			continue;
		}
		if (src.startsWith("<?", lt)) {
			const end = src.indexOf("?>", lt + 2);
			i = end < 0 ? src.length : end + 2;
			continue;
		}
		if (src.startsWith("<!", lt)) {
			// DOCTYPE (with an internal subset in brackets) or another declaration: skipped.
			let depth = 0, j = lt + 2;
			for (; j < src.length; j++) {
				if (src[j] === "[") { depth++; }
				else if (src[j] === "]") { depth--; }
				else if (src[j] === ">" && depth <= 0) { break; }
			}
			i = j + 1;
			continue;
		}
		const gt = findTagEnd(src, lt + 1);
		if (gt < 0) { addText(src.slice(lt)); break; }
		const body = src.slice(lt + 1, gt);
		if (!/^\/?[A-Za-z_]/.test(body)) { addText("<"); i = lt + 1; continue; }
		i = gt + 1;
		if (body[0] === "/") {
			const name = body.slice(1).trim();
			// Close up to the matching open element; an unmatched close is ignored.
			for (let k = stack.length - 1; k > 0; k--) {
				if (stack[k].name === name) { stack.length = k; break; }
			}
			continue;
		}
		const selfClosing = body.endsWith("/");
		const inner = selfClosing ? body.slice(0, -1) : body;
		const sp = inner.search(/\s/);
		const name = sp < 0 ? inner : inner.slice(0, sp);
		const el = { name, local: localName(name), attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)), children: [] };
		top().children.push(el);
		if (!selfClosing) { stack.push(el); }
	}
	return root;
}

// The ">" that ends a tag, past quoted attribute values.
function findTagEnd(src, from) {
	let q = null;
	for (let j = from; j < src.length; j++) {
		const c = src[j];
		if (q) { if (c === q) { q = null; } }
		else if (c === "\"" || c === "'") { q = c; }
		else if (c === ">") { return j; }
	}
	return -1;
}

const elements = (el) => (el && el.children ? el.children.filter((c) => c.name) : []);

// The first descendant (depth first) with that local name, or null.
function find(el, local) {
	for (const c of elements(el)) {
		if (c.local === local) { return c; }
		const d = find(c, local);
		if (d) { return d; }
	}
	return null;
}

// Every descendant with that local name, in document order.
function findAll(el, local, out = []) {
	for (const c of elements(el)) {
		if (c.local === local) { out.push(c); }
		findAll(c, local, out);
	}
	return out;
}

function textOf(el) {
	if (!el) { return ""; }
	if (el.text !== undefined) { return el.text; }
	return (el.children || []).map(textOf).join("");
}

// The text of the first direct child with that local name ("" for none), trimmed.
function childText(el, local) {
	const c = elements(el).find((x) => x.local === local);
	return c ? textOf(c).trim() : "";
}

function children(el, local) {
	return elements(el).filter((x) => x.local === local);
}

const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	.replace(/"/g, "&quot;").replace(/'/g, "&apos;");

module.exports = { parse, decode, find, findAll, textOf, childText, children, elements, escape, localName };
