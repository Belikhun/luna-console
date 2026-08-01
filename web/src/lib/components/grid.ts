/** Cell definition for InfoGrid (vloom ScreenGrid-style). */
export interface InfoCell {
	id?: string;
	label: string;
	value?: string | number | null;
	copyable?: boolean;
	/** value rendering style */
	style?: 'default' | 'heading' | 'code' | 'mono';
	colSpan?: number | 'all';
	help?: string;
}
