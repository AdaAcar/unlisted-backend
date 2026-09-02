/**
 * Authorization: the single policy module.
 *
 * `policy(actor, action, resource) -> allow | deny`, deny by default. The rule
 * table is data, not a chain of conditionals, so it can be tested exhaustively
 * and read as a spec. An ownership check is never inlined in a route handler.
 *
 * Populated in task A5.
 */
export {};
