import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import satori from "satori";

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

type OgNode = {
	type: string;
	props: {
		style: Record<string, string | number>;
		children: Array<OgNode | string>;
	};
};

function box(
	style: Record<string, string | number>,
	children: Array<OgNode | string> = [],
): OgNode {
	return {
		type: "div",
		props: { style: { display: "flex", ...style }, children },
	};
}


function label(text: string, style: Record<string, string | number> = {}) {
	return box(style, [text]);
}

let wasmReady: Promise<void> | undefined;
void satori(box({ width: 1, height: 1 }), {
	width: 1,
	height: 1,
	fonts: [],
}).catch((error: unknown) => console.error("Satori warmup failed", error));

function fontBytes() {
	const decoded = atob(interLatinBase64);
	const bytes = new Uint8Array(decoded.length);
	for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
	return bytes;
}

function initializeWasm() {
	wasmReady ??= initWasm(resvgWasm).catch((error: unknown) => {
		wasmReady = undefined;
		throw error;
	});
	return wasmReady;
}

export async function buildFormOgSvg(form: OgForm, fields: OgField[]) {
	const font = fontBytes();
	const accent = accents[form.accent ?? ""] ?? accents.blue!;
	const title = form.title.trim().slice(0, 140) || "Untitled form";
	const description = (form.description ?? "").trim().slice(0, 180);
	const previewFields = fields.slice(0, 3);
	const extraFieldCount = Math.max(0, fields.length - previewFields.length);
	const fieldRows = previewFields.map((field, index) => {
		const fieldLabel = field.label?.trim() || `Question ${index + 1}`;
		return box(
			{
				flexDirection: "column",
				gap: 10,
				padding: "20px 22px",
				border: "1px solid #e5eaf1",
				borderRadius: 16,
				backgroundColor: "#ffffff",
				marginBottom: 14,
			},
			[
				label(fieldLabel, { fontSize: 18, fontWeight: 600, color: "#1d2939" }),
				box({
					height: 13,
					width: index === 1 ? "72%" : "86%",
					borderRadius: 8,
					backgroundColor: "#f1f4f8",
				}),
			],
		);
	});
	const previewHeader = box(
		{ alignItems: "center", gap: 9, marginBottom: 24 },
		[
			box({
				width: 8,
				height: 8,
				borderRadius: "100%",
				backgroundColor: accent,
			}),
			label("FORM PREVIEW", {
				fontSize: 13,
				fontWeight: 700,
				letterSpacing: 1.2,
				color: "#667085",
			}),
		],
	);
	const previewCard = box(
		{
			flexDirection: "column",
			width: "100%",
			maxHeight: 510,
			backgroundColor: "#ffffff",
			border: "1px solid #e4eaf2",
			borderRadius: 27,
			padding: 29,
			boxSizing: "border-box",
			boxShadow: "0px 18px 50px rgba(16,24,40,0.10)",
			overflow: "hidden",
		},
		[
			previewHeader,
			...(fieldRows.length
				? fieldRows
				: [
						box(
							{
								flexDirection: "column",
								gap: 10,
								padding: "20px 22px",
								border: "1px solid #e5eaf1",
								borderRadius: 16,
								backgroundColor: "#ffffff",
								marginBottom: 14,
							},
							[
								label("Your first question", {
									fontSize: 18,
									fontWeight: 600,
									color: "#1d2939",
								}),
								box({
									height: 13,
									width: "86%",
									borderRadius: 8,
									backgroundColor: "#f1f4f8",
								}),
							],
						),
					]),
			...(extraFieldCount
				? [
						label(
							`+ ${extraFieldCount} more ${extraFieldCount === 1 ? "question" : "questions"}`,
							{ fontSize: 15, color: "#667085", marginTop: 3 },
						),
					]
				: []),
			label("Submit", {
				alignItems: "center",
				justifyContent: "center",
				alignSelf: "flex-start",
				minWidth: 110,
				height: 42,
				padding: "0 20px",
				marginTop: 22,
				borderRadius: 12,
				backgroundColor: accent,
				color: "#ffffff",
				fontSize: 16,
				fontWeight: 700,
			}),
		],
	);
	const brand = box({ alignItems: "center", gap: 13 }, [
		label("F", {
			alignItems: "center",
			justifyContent: "center",
			width: 44,
			height: 44,
			borderRadius: 13,
			backgroundColor: accent,
			color: "#ffffff",
			fontSize: 22,
			fontWeight: 700,
		}),
		label("URLX Forms", {
			fontSize: 22,
			fontWeight: 700,
			letterSpacing: -0.4,
			color: "#101828",
		}),
	]);
	const titleGroup = box({ flexDirection: "column", gap: 20, marginTop: 20 }, [
		label("A FORM TO FILL OUT", {
			color: accent,
			fontSize: 16,
			fontWeight: 700,
			letterSpacing: 1.6,
		}),
		label(title, {
			fontSize: 57,
			lineHeight: 1.08,
			fontWeight: 700,
			letterSpacing: -2,
			color: "#101828",
			maxHeight: 250,
			overflow: "hidden",
		}),
		...(description
			? [
					label(description, {
						fontSize: 22,
						lineHeight: 1.45,
						color: "#667085",
						maxHeight: 96,
						overflow: "hidden",
					}),
				]
			: []),
	]);
	const footer = box(
		{ alignItems: "center", gap: 11, color: "#667085", fontSize: 16 },
		[
			box({
				width: 8,
				height: 8,
				borderRadius: "100%",
				backgroundColor: accent,
			}),
			label("Simple, thoughtful forms by URLX", {
				color: "#667085",
				fontSize: 16,
			}),
		],
	);
	const tree = box(
		{
			width: WIDTH,
			height: HEIGHT,
			position: "relative",
			overflow: "hidden",
			backgroundColor: "#f4f7fb",
			fontFamily: "Inter",
			color: "#101828",
			padding: "58px 68px",
			boxSizing: "border-box",
		},
		[
			box(
				{
					flexDirection: "column",
					justifyContent: "space-between",
					width: "53%",
					paddingRight: 58,
				},
				[brand, titleGroup, footer],
			),
			box(
				{
					alignItems: "center",
					justifyContent: "center",
					width: "47%",
					position: "relative",
				},
				[previewCard],
			),
		],
	);
	const svg = await satori(tree, {
		width: WIDTH,
		height: HEIGHT,
		fonts: [
			{ name: "Inter", data: font, weight: 400 },
			{ name: "Inter", data: font, weight: 700 },
		],
	});
	return svg;
}

export async function renderFormOg(form: OgForm, fields: OgField[]) {
	await initializeWasm();
	const svg = await buildFormOgSvg(form, fields);
	const font = fontBytes();
	const renderer = new Resvg(svg, {
		fitTo: { mode: "width", value: WIDTH },
		font: {
			fontBuffers: [font],
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
