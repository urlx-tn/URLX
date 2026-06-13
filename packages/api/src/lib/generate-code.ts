const alphabet =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const defaultLength = 7;
const maxRandomValue = Math.floor(256 / alphabet.length) * alphabet.length;

export function generateShortCode(length = defaultLength) {
	const bytes = new Uint8Array(length * 2);
	let code = "";

	while (code.length < length) {
		crypto.getRandomValues(bytes);

		for (const byte of bytes) {
			if (byte >= maxRandomValue) {
				continue;
			}

			const char = alphabet[byte % alphabet.length];

			if (!char) {
				continue;
			}

			code += char;

			if (code.length === length) {
				break;
			}
		}
	}

	return code;
}
