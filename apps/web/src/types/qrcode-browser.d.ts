declare module "qrcode/lib/browser.js" {
	import type { QRCodeToStringOptions } from "qrcode";

	const QRCode: {
		toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
	};

	export default QRCode;
}
