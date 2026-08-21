// @ts-nocheck
import { wrapHandler } from "../server/_lib/wrap";

export const config = { maxDuration: 60 };
export default wrapHandler(() => import("../bundled/close.cjs"));
