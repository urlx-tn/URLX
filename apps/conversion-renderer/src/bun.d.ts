declare const Bun: {
	serve(options: {
		port: number;
		hostname: string;
		fetch(request: Request): Response | Promise<Response>;
	}): {
		hostname: string;
		port: number;
		stop(force?: boolean): Promise<void>;
	};
};
