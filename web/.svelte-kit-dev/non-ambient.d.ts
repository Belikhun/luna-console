
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	type MatcherParam<M> = M extends (param : string) => param is (infer U extends string) ? U : string;

	export interface AppTypes {
		RouteId(): "/" | "/api" | "/api/cleanup" | "/api/events" | "/api/host" | "/api/instances" | "/api/instances/create" | "/api/instances/[name]" | "/api/instances/[name]/config" | "/api/instances/[name]/console" | "/api/instances/[name]/logs" | "/api/instances/[name]/metrics" | "/api/instances/[name]/plugins" | "/api/instances/[name]/state" | "/api/luna" | "/api/luna/admin" | "/api/luna/players" | "/api/luna/stream" | "/api/luna/telemetry" | "/api/paper" | "/api/plugins" | "/api/plugins/add" | "/api/plugins/check" | "/api/plugins/deploy" | "/api/plugins/pin" | "/api/plugins/scan" | "/api/plugins/search" | "/api/plugins/unpin" | "/api/plugins/update" | "/api/plugins/[name]" | "/api/ports" | "/api/proxy" | "/api/shell" | "/api/shell/complete" | "/api/shell/exec" | "/cleanup" | "/gallery" | "/instances" | "/instances/launch" | "/instances/[name]" | "/instances/[name]/console" | "/network" | "/plugins" | "/proxy";
		RouteParams(): {
			"/api/instances/[name]": { name: string };
			"/api/instances/[name]/config": { name: string };
			"/api/instances/[name]/console": { name: string };
			"/api/instances/[name]/logs": { name: string };
			"/api/instances/[name]/metrics": { name: string };
			"/api/instances/[name]/plugins": { name: string };
			"/api/instances/[name]/state": { name: string };
			"/api/plugins/[name]": { name: string };
			"/instances/[name]": { name: string };
			"/instances/[name]/console": { name: string }
		};
		LayoutParams(): {
			"/": { name?: string | undefined };
			"/api": { name?: string | undefined };
			"/api/cleanup": Record<string, never>;
			"/api/events": Record<string, never>;
			"/api/host": Record<string, never>;
			"/api/instances": { name?: string | undefined };
			"/api/instances/create": Record<string, never>;
			"/api/instances/[name]": { name: string };
			"/api/instances/[name]/config": { name: string };
			"/api/instances/[name]/console": { name: string };
			"/api/instances/[name]/logs": { name: string };
			"/api/instances/[name]/metrics": { name: string };
			"/api/instances/[name]/plugins": { name: string };
			"/api/instances/[name]/state": { name: string };
			"/api/luna": Record<string, never>;
			"/api/luna/admin": Record<string, never>;
			"/api/luna/players": Record<string, never>;
			"/api/luna/stream": Record<string, never>;
			"/api/luna/telemetry": Record<string, never>;
			"/api/paper": Record<string, never>;
			"/api/plugins": { name?: string | undefined };
			"/api/plugins/add": Record<string, never>;
			"/api/plugins/check": Record<string, never>;
			"/api/plugins/deploy": Record<string, never>;
			"/api/plugins/pin": Record<string, never>;
			"/api/plugins/scan": Record<string, never>;
			"/api/plugins/search": Record<string, never>;
			"/api/plugins/unpin": Record<string, never>;
			"/api/plugins/update": Record<string, never>;
			"/api/plugins/[name]": { name: string };
			"/api/ports": Record<string, never>;
			"/api/proxy": Record<string, never>;
			"/api/shell": Record<string, never>;
			"/api/shell/complete": Record<string, never>;
			"/api/shell/exec": Record<string, never>;
			"/cleanup": Record<string, never>;
			"/gallery": Record<string, never>;
			"/instances": { name?: string | undefined };
			"/instances/launch": Record<string, never>;
			"/instances/[name]": { name: string };
			"/instances/[name]/console": { name: string };
			"/network": Record<string, never>;
			"/plugins": Record<string, never>;
			"/proxy": Record<string, never>
		};
		Pathname(): "/" | "/api/cleanup" | "/api/events" | "/api/host" | "/api/instances" | "/api/instances/create" | `/api/instances/${string}` & {} | `/api/instances/${string}/config` & {} | `/api/instances/${string}/console` & {} | `/api/instances/${string}/logs` & {} | `/api/instances/${string}/metrics` & {} | `/api/instances/${string}/plugins` & {} | `/api/instances/${string}/state` & {} | "/api/luna/admin" | "/api/luna/players" | "/api/luna/stream" | "/api/luna/telemetry" | "/api/paper" | "/api/plugins" | "/api/plugins/add" | "/api/plugins/check" | "/api/plugins/deploy" | "/api/plugins/pin" | "/api/plugins/scan" | "/api/plugins/search" | "/api/plugins/unpin" | "/api/plugins/update" | `/api/plugins/${string}` & {} | "/api/ports" | "/api/proxy" | "/api/shell/complete" | "/api/shell/exec" | "/cleanup" | "/gallery" | "/instances" | "/instances/launch" | `/instances/${string}` & {} | `/instances/${string}/console` & {} | "/network" | "/plugins" | "/proxy";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/FontAwesome/fa-light-300.woff2" | "/FontAwesome/fa-solid-900.woff2" | "/FontAwesome/fa-brands-400.woff2" | "/FontAwesome/FontAwesome.css" | "/FontAwesome/fa-regular-400.woff2" | "/FontAwesome/fa-thin-100.woff2" | "/robots.txt" | "/AlbulaPro/AlbulaPro-SemiLight.woff2" | "/AlbulaPro/AlbulaPro-ThinOblique.woff2" | "/AlbulaPro/AlbulaPro-ExtraLightOblique.woff2" | "/AlbulaPro/AlbulaPro-LightOblique.woff2" | "/AlbulaPro/AlbulaPro-Medium.woff2" | "/AlbulaPro/AlbulaPro-ExtraBold.woff2" | "/AlbulaPro/AlbulaPro-SemiLightOblique.woff2" | "/AlbulaPro/AlbulaPro-ExtraBoldOblique.woff2" | "/AlbulaPro/AlbulaPro-Regular.woff2" | "/AlbulaPro/AlbulaPro-MediumOblique.woff2" | "/AlbulaPro/AlbulaPro-SemiBoldOblique.woff2" | "/AlbulaPro/AlbulaPro-SemiBold.woff2" | "/AlbulaPro/AlbulaPro-BoldOblique.woff2" | "/AlbulaPro/AlbulaPro-Thin.woff2" | "/AlbulaPro/AlbulaPro-Oblique.woff2" | "/AlbulaPro/AlbulaPro-Bold.woff2" | "/AlbulaPro/AlbulaPro-ExtraLight.woff2" | "/AlbulaPro/AlbulaPro-Light.woff2" | "/AlbulaPro/AlbulaPro.css" | string & {};
	}
}