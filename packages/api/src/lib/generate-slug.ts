const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const defaultLength = 8;
const maxRandomValue = Math.floor(256 / alphabet.length) * alphabet.length;

// Generates a lowercase alphanumeric slug for bio pages created without a custom
// handle. Uses a CSPRNG with rejection sampling to avoid modulo bias, mirroring
// generate-code.ts.
export function generateSlug(length = defaultLength) {
	const bytes = new Uint8Array(length * 2);
	let slug = "";

	while (slug.length < length) {
		crypto.getRandomValues(bytes);

		for (const byte of bytes) {
			if (byte >= maxRandomValue) {
				continue;
			}

			const char = alphabet[byte % alphabet.length];

			if (!char) {
				continue;
			}

			slug += char;

			if (slug.length === length) {
				break;
			}
		}
	}

	return slug;
}
