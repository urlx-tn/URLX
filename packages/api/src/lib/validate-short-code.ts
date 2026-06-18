export const shortCodePattern = /^[0-9A-Za-z]{7,16}$/;

export function isValidShortCode(shortCode: string) {
	return shortCodePattern.test(shortCode);
}
