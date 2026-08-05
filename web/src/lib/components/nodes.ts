/** Types for NodeEditorModal (LuckPerms node create/edit dialog). */

/** What the editor hands back: one node ready to be applied. */
export interface NodeSpec {
	key: string;
	value: boolean;
	/** 0 = permanent */
	expirySeconds: number;
	contexts: Record<string, string>;
}

/** The shape the editor accepts for pre-filling; matches the API's node rows. */
export interface EditableNode {
	key: string;
	value: boolean;
	expiryEpochMillis: number;
	contexts: Array<{ key: string; value: string }>;
}
