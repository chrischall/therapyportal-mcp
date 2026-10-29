// The `view` vocabulary every read tool in this server honours
// (`@chrischall/mcp-utils`' `view`; chrischall/workflows `docs/fleet-conventions.md`,
// "Response shape"). compact is the default and the cheap rung.
//
// Two kits, because the portal's reads split cleanly in two:
//
//   * PASS-THROUGH reads hand back one endpoint's payload, so `raw` can mean
//     "the portal payload untouched" and is worth offering.
//   * ASSEMBLED reads are STITCHED here — parsed out of an HTML fragment, or
//     built from a handful of fields — so there is no untouched upstream object
//     to show and `raw` would alias `full`. Those offer compact + full only.
//
// A third shape, {@link untrustedViewResponse}, is for reads carrying
// practice-authored free text (message subjects/bodies, form and survey names):
// same rung handling, but the result is wrapped in the untrusted-data envelope
// so the model is told the text is data, never instructions.

import {
  UNTRUSTED_CONTENT_RULE,
  createViewKit,
  projectOrRaw,
  resolveView,
  untrustedEnvelope,
  viewResult,
  type View,
} from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';

const LABEL = 'therapyportal-mcp';

const PASSTHROUGH_NOTE =
  'compact projects each record to the fields a caller acts on; "full" keeps every field ' +
  'this server understands; "raw" returns the portal payload untouched.';

const ASSEMBLED_NOTE =
  'compact projects each record to the fields a caller acts on; "full" keeps every field ' +
  'this server understands. (No "raw": the record is assembled here, not passed through from ' +
  'one endpoint.)';

const passthrough = createViewKit(['compact', 'full', 'raw'], { note: PASSTHROUGH_NOTE, label: LABEL });
const assembled = createViewKit(['compact', 'full'], { note: ASSEMBLED_NOTE, label: LABEL });

/** The `view` argument + responder for a pass-through read (compact/full/raw). */
export const viewArg = passthrough.viewArg;
export const viewResponse = passthrough.viewResponse;
export const PASSTHROUGH_VIEWS = passthrough.views;

/** The `view` argument + responder for an assembled read (compact/full). */
export const assembledViewArg = assembled.viewArg;
export const assembledViewResponse = assembled.viewResponse;
export const ASSEMBLED_VIEWS = assembled.views;

/** A tool's own compact-rung field projection. */
export type Projector = (data: unknown) => unknown;

/**
 * Answer a read whose payload carries practice-authored free text. The rung is
 * honoured exactly as {@link viewResponse} honours it (compact projects, full
 * and raw pass through; compact/full minified, raw indented), but the result is
 * first wrapped in the untrusted-data envelope — markers lead, so they precede
 * any third-party text in the serialised result.
 */
export function untrustedViewResponse(opts: {
  view: string | undefined;
  views: readonly View[];
  data: unknown;
  project?: Projector;
  /** Who authored the text, e.g. "Message subjects and bodies are written by your practice." */
  whoWrote: string;
  /** Which call produced `data`, for the stderr line on a projection fallback. */
  context: string;
}): CallToolResult {
  const rung = resolveView(opts.view, opts.views);
  const payload =
    rung === 'compact' && opts.project !== undefined
      ? projectOrRaw(opts.data, opts.project, { label: LABEL, context: opts.context })
      : opts.data;
  return viewResult(rung, untrustedEnvelope(payload, { note: `${opts.whoWrote} ${UNTRUSTED_CONTENT_RULE}` }));
}
