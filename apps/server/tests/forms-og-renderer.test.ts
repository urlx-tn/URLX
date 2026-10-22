import { describe, expect, it, vi } from "vitest";

vi.mock("@resvg/resvg-wasm", () => ({ initWasm: vi.fn(), Resvg: vi.fn() }));
vi.mock("@resvg/resvg-wasm/index_bg.wasm", () => ({
	default: new Uint8Array(),
}));

import { buildFormOgSvg } from "../src/forms-og/renderer";

describe("forms Open Graph renderer", () => {
	it("escapes untrusted text and only emits allowlisted accent colors", async () => {
		const svg = await buildFormOgSvg(
			{
				title: "A <b> & title",
				description: "Collect A & B <info> safely",
				accent: "url(https://attacker.invalid/#fff)",
			},
			[{ label: "Name <img src=x onerror=alert(1)>" }],
		);

		expect(svg).toContain("A &lt;b&gt; &amp; title");
		expect(svg).toContain("Collect A &amp; B &lt;info&gt; safely");
		expect(svg).toContain("Name &lt;img src=x onerror=alert(1)&gt;");
		expect(svg).not.toContain("<script>");
		expect(svg).not.toContain("<img");
		expect(svg).not.toContain("attacker.invalid");
		expect(svg).toContain('fill="#0071e3"');
	});
});
