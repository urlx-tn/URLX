declare module "qrcode/lib/browser.js" {
	import type { QRCodeToDataURLOptions, QRCodeToStringOptions } from "qrcode";

	const QRCode: {
		toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
		toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
	};

	export default QRCode;
}
