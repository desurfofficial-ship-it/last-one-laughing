/**
 * Re-export shim: ArenaPhysics moved to `shared/src/physics/` (stage 2) so the
 * authoritative server runs the exact same simulation. All client imports
 * stay on this path.
 */
export * from '../../../../shared/src/physics/ArenaPhysics';
