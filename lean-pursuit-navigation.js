/*
===========================================================================
lean-pursuit-navigation.js - bounded, explicit pursuit and escape queries

Uses admitted game collision products. A query never changes a player pose;
the native movement command and its observed result remain authoritative.
===========================================================================
*/
const PURSUIT_NAV = { nodes: 6000, chord: 120, step: 60, arrive: 7, candidates: 4 };

/*
================
Navigation.covered
================
*/
Navigation.covered = function( x, z ) {
	return !!this.scene?.grids.has( Math.floor( x / SECTOR ) + "," + Math.floor( z / SECTOR ) );
};

/*
================
Navigation.pointStatus

Terrain openness alone is not object clearance. Closed object interiors still
require a reachable chord; this query deliberately makes no ownership claim.
================
*/
Navigation.pointStatus = function( pose ) {
	if ( !pose || !this.scene || pose.regionId & DUNGEON ) return "unknown";
	const p = this.local( pose );
	if ( !p || !this.covered( p.x, p.z ) ) return "unknown";
	return this.open( p.x, p.z ) && this.clear( p, p ) ? "open" : "blocked";
};

/*
================
Navigation.setClipQuery

Optional synchronous, read-only client adapter. A missing/unknown reply never
authorizes movement. The default implementation uses the existing bundle.
================
*/
Navigation.setClipQuery = function( query = null ) {
	if ( query !== null && typeof query !== "function" ) throw Error( "Invalid clip query" );
	this.clipQuery = query;
};

/*
================
Navigation.segment
================
*/
Navigation.segment = function( from, to, departing = false ) {
	if ( !from || !to || !Number.isFinite( dist2D( from, to ) ) ) return false;
	// This product describes X/Z traversal, not terrain slope. Native movement
	// resolves height; a destination's different Y is not evidence of a wall.
	if ( this.pointStatus( to ) !== "open" ) return false;
	const a = this.local( from ), b = this.local( to );
	if ( !a || !b || !this.clear( a, b, departing ) ) return false;
	if ( !this.clipQuery ) return true;
	try {
		const clipped = this.clipQuery( {
			from: { ...from },
			to: { ...to },
			epoch: World.epoch,
			revision: this.revision
		} );
		return !!clipped && clipped.epoch === World.epoch && clipped.revision === this.revision &&
			Number.isFinite( clipped.pose?.y ) && Math.abs( clipped.pose.y - (to.y ?? 0) ) <= 2 &&
			dist2D( clipped.pose, to ) <= 2;
	} catch {
		return false;
	}
};

/*
================
Navigation.query

The legacy plan/next interface stays intact for town and recorded routes.
Pursuit must distinguish an unavailable map from a proven failed search.
================
*/
Navigation.query = function( from, to, maxNodes = PURSUIT_NAV.nodes ) {
	const start = this.pointStatus( from ), end = this.pointStatus( to );
	if ( start === "unknown" || end === "unknown" ) return { status: "unknown", route: [] };
	if ( start === "blocked" ) return { status: "invalid-start", route: [] };
	if ( this.segment( from, to ) ) return { status: "direct", route: [ to ] };
	const result = {};
	// Pursuit plans many times a fight: the flat grid alone, never a clipper search.
	const route = this.plan( from, to, 0, { maxNodes, maxChord: PURSUIT_NAV.chord, result, clip: false } );
	if ( !route?.length ) {
		return { status: result.limited ? "search-limit" : "unreachable", route: [], visited: result.visited };
	}
	let previous = from;
	for ( const point of route ) {
		if ( !this.segment( previous, point ) ) return { status: "unreachable", route: [], visited: result.visited };
		previous = point;
	}
	return { status: "route", route, visited: result.visited };
};

/*
================
Navigation.attackRoute

Only consider nearby stand-off goals when their final approach is clear.
Walking obstruction is never treated as projectile line-of-sight.
================
*/
Navigation.attackRoute = function( from, target, radius, failed = [] ) {
	const direct = this.query( from, target );
	if ( ![ "route", "unreachable" ].includes( direct.status ) || radius <= PURSUIT_NAV.arrive ) return direct;
	const delta = regionDelta( target, from );
	if ( !delta ) return direct;
	const angle = Math.atan2( delta[1], delta[0] ), local = this.local( target );
	let budget = PURSUIT_NAV.nodes - (direct.visited || 0);
	for ( let i = 0; i < PURSUIT_NAV.candidates && budget > 0; i++ ) {
		const theta = angle + [ 0, Math.PI / 2, -Math.PI / 2, Math.PI ][i];
		const goal = this.pose(
			{ x: local.x + Math.cos( theta ) * radius, z: local.z + Math.sin( theta ) * radius },
			from.y
		);
		if ( failed.some( p => dist2D( p, goal ) < PURSUIT_NAV.step ) || !this.segment( goal, target ) ) continue;
		const route = this.query( from, goal, budget );
		budget -= route.visited || 0;
		// A direct leg to a stand-off goal still needs explicit movement.
		if ( route.status === "route" || route.status === "direct" ) return { ...route, status: "route" };
	}
	return direct;
};

/*
================
Navigation.escapeCandidates

Never cross object walls to get out of a blocked terrain start. Native terrain
departure permits a contiguous blocked prefix, but not reentry or missing data.
================
*/
Navigation.escapeCandidates = function( from ) {
	if ( !this.scene || !from || from.regionId & DUNGEON ) return [];
	const p = this.local( from ), out = [];
	for ( const radius of [ 20, 40, 80, 120 ] ) {
		for ( let i = 0; i < 8; i++ ) {
			const theta = i * Math.PI / 4;
			const to = this.pose(
				{ x: p.x + Math.cos( theta ) * radius, z: p.z + Math.sin( theta ) * radius },
				from.y
			);
			if ( this.segment( from, to, true ) ) out.push( to );
		}
		if ( out.length >= PURSUIT_NAV.candidates ) break;
	}
	return out.sort( ( a, b ) => dist2D( from, a ) - dist2D( from, b ) ).slice( 0, PURSUIT_NAV.candidates );
};
