// Types for bootstrap.js, which stays plain JS with no Node imports: the mobile app runs that same
// file in its WebView to start wisp from a phone.

/** [step id, label] in the order a connection goes through them. */
export declare const STEPS: readonly (readonly [string, string])[];
export declare const NODE_LINE: string;
export declare function nodeInstallScript(o?: { dist?: string }): string;
/** apiVersion 'any' takes whichever wisp already runs there. */
export declare function bootstrapScript(o: { port: number; command: string; apiVersion: number | string; installNode?: boolean }): string;
