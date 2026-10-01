/**
 * How often /staff/rigs re-renders itself. The flow view spaces its lap
 * labels over this whole interval, since its dots keep moving until then.
 */
export const RIG_HEALTH_REFRESH_MS = 15_000;
