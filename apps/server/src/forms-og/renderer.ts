import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

import { interLatinBase64 } from "./font-data";

const WIDTH = 1200;
const HEIGHT = 630;
const accents: Record<string, string> = {
	blue: "#0071e3",
	teal: "#0e7c86",
	green: "#248a3d",
	orange: "#c2410c",
	pink: "#c2185b",
	graphite: "#48484a",
};

export type OgForm = {
	title: string;
	description?: string | null;
	accent?: string | null;
};

export type OgField = {
	label?: string;
	type?: string;
};

let wasmReady: Promise<void> | undefined;

function fontBytes() {
	const decoded = atob(interLatinBase64);
	const bytes = new Uint8Array(decoded.length);
	for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
	return bytes;
}

function escapeXml(text: string) {
	return text.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&apos;";
		}
	});
}

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
	const words = text.trim().split(/\s+/u).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const originalWord of words) {
		let word = Array.from(originalWord);
		while (word.length > maxChars) {
			if (line) {
				lines.push(line);
				line = "";
			}
			lines.push(word.slice(0, maxChars).join(""));
			word = word.slice(maxChars);
			if (lines.length >= maxLines) break;
		}
		if (lines.length >= maxLines) break;
		const piece = word.join("");
		if (line && Array.from(`${line} ${piece}`).length > maxChars) {
			lines.push(line);
			line = piece;
		} else {
			line = line ? `${line} ${piece}` : piece;
		}
	}
	if (lines.length < maxLines && line) lines.push(line);
	if (lines.length === maxLines) {
		const consumed = lines.join(" ").length < text.trim().length;
		const lastLine = lines[maxLines - 1];
		if (consumed && lastLine !== undefined)
			lines[maxLines - 1] = `${Array.from(lastLine)
				.slice(0, maxChars - 1)
				.join("")}…`;
	}
	return lines;
}

function svgTextLines(
	lines: string[],
	x: number,
	y: number,
	lineHeight: number,
) {
	return lines
		.map(
			(line, index) =>
				`<tspan x="${x}" y="${y + index * lineHeight}">${escapeXml(line)}</tspan>`,
		)
		.join("");
}

export async function buildFormOgSvg(form: OgForm, fields: OgField[]) {
	const accent = accents[form.accent ?? ""] ?? "#0071e3";
	const title = wrapText(form.title.trim() || "Untitled form", 22, 3);
	const description = wrapText((form.description ?? "").trim(), 42, 2);
	const titleMarkup = svgTextLines(title, 68, 310, 62);
	const descriptionY = Math.min(468, 310 + title.length * 62 + 34);
	const descriptionMarkup = svgTextLines(description, 68, descriptionY, 32);
	const previewFields = fields.slice(0, 3);
	const visibleFields = previewFields.length
		? previewFields
		: [{ label: "Your first question" }];
	const fieldRows = visibleFields
		.map((field, index) => {
			const y = 152 + index * 101;
			const fieldLabel = Array.from(
				field.label?.trim() || `Question ${index + 1}`,
			)
				.slice(0, 56)
				.join("");
			return `<rect x="662" y="${y}" width="440" height="87" rx="16" fill="#fff" stroke="#e5eaf1"/><text x="685" y="${y + 36}" font-family="Inter" font-size="18" font-weight="600" fill="#1d2939">${escapeXml(fieldLabel)}</text><rect x="685" y="${y + 53}" width="330" height="13" rx="7" fill="#f1f4f8"/>`;
		})
		.join("");
	const extraFieldCount = Math.max(0, fields.length - previewFields.length);
	const extraLabel = extraFieldCount
		? `<text x="662" y="${152 + visibleFields.length * 101 + 10}" font-family="Inter" font-size="15" fill="#667085">+ ${extraFieldCount} more ${extraFieldCount === 1 ? "question" : "questions"}</text>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="1200" height="630" fill="#f4f7fb"/><rect x="68" y="58" width="44" height="44" rx="13" fill="${accent}"/><text x="82" y="88" font-family="Inter" font-size="22" font-weight="700" fill="#fff">F</text><text x="125" y="88" font-family="Inter" font-size="22" font-weight="700" fill="#101828">URLX Forms</text><text x="68" y="246" font-family="Inter" font-size="16" font-weight="700" letter-spacing="1.6" fill="${accent}">A FORM TO FILL OUT</text><text font-family="Inter" font-size="57" font-weight="700" fill="#101828">${titleMarkup}</text>${description.length ? `<text font-family="Inter" font-size="22" fill="#667085">${descriptionMarkup}</text>` : ""}<rect x="632" y="83" width="500" height="466" rx="27" fill="#fff" stroke="#e4eaf2"/><circle cx="665" cy="120" r="4" fill="${accent}"/><text x="680" y="125" font-family="Inter" font-size="13" font-weight="700" letter-spacing="1" fill="#667085">FORM PREVIEW</text>${fieldRows}${extraLabel}<rect x="662" y="472" width="110" height="42" rx="12" fill="${accent}"/><text x="692" y="499" font-family="Inter" font-size="16" font-weight="700" fill="#fff">Submit</text><circle cx="72" cy="563" r="4" fill="${accent}"/><text x="87" y="569" font-family="Inter" font-size="16" fill="#667085">Simple, thoughtful forms by URLX</text></svg>`;
}

function initializeWasm() {
	wasmReady ??= initWasm(resvgWasm).catch((error: unknown) => {
		wasmReady = undefined;
		throw error;
	});
	return wasmReady;
}

export async function renderFormOg(form: OgForm, fields: OgField[]) {
	await initializeWasm();
	const svg = await buildFormOgSvg(form, fields);
	const renderer = new Resvg(svg, {
		fitTo: { mode: "width", value: WIDTH },
		font: {
			fontBuffers: [fontBytes()],
			defaultFontFamily: "Inter",
			loadSystemFonts: false,
		},
	});
	try {
		return renderer.render().asPng();
	} finally {
		renderer.free();
	}
}
