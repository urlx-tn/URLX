type QrCodeBrowserModule = typeof import("qrcode/lib/browser.js");
type QrCodeBrowser = QrCodeBrowserModule["default"];

let qrPromise: Promise<QrCodeBrowser> | null = null;

const loadQrCode = async (): Promise<QrCodeBrowser> => {
	if (!qrPromise) {
		qrPromise = import("qrcode/lib/browser.js").then(
			(module) => module.default,
		);
	}
	return qrPromise;
};

export interface QrRenderOptions {
	margin?: number;
	width?: number;
	color?: { dark?: string; light?: string };
}

export const renderQrSvg = async (
	text: string,
	options: QrRenderOptions = {},
): Promise<string> => {
	const QRCode = await loadQrCode();
	return QRCode.toString(text, {
		type: "svg",
		errorCorrectionLevel: "M",
		margin: options.margin ?? 1,
		width: options.width,
		color: options.color,
	});
};

export const renderQrPngDataUrl = async (
	text: string,
	options: QrRenderOptions = {},
): Promise<string> => {
	const QRCode = await loadQrCode();
	return QRCode.toDataURL(text, {
		errorCorrectionLevel: "M",
		type: "image/png",
		margin: options.margin ?? 1,
		width: options.width ?? 1024,
		color: options.color,
	});
};
