/**
 * Bridge mirror of core/screen; screen sessions live on the same host as the
 * daemon the client talks to, and attaching needs the caller's own terminal,
 * so this module stays entirely local.
 */

export * from "../../core/screen";
