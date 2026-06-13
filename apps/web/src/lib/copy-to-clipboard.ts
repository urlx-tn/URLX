const writeWithClipboardApi = async (text: string): Promise<boolean> => {
	if (
		typeof navigator !== "undefined" &&
		navigator.clipboard &&
		typeof navigator.clipboard.writeText === "function"
	) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}
	return false;
};

const writeWithExecCommand = (text: string): boolean => {
	if (typeof document === "undefined") {
		return false;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "0";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	let success = false;
	try {
		success = document.execCommand("copy");
	} catch {
		success = false;
	}
	document.body.removeChild(textarea);
	return success;
};

export const copyToClipboard = async (text: string): Promise<boolean> => {
	if (await writeWithClipboardApi(text)) {
		return true;
	}
	return writeWithExecCommand(text);
};
