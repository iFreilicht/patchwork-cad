/**
 * wideLines.js — three.js's wide lines (examples/jsm/lines: LineSegmentsGeometry, LineMaterial,
 * LineSegments2) made with a given three.js, copied whole from three 0.186.1: each file in a scope
 * of its own, its imports the argument's members. A scene draws only objects made with its own
 * three.js, and it doesn't give these to plugins (research/23-scene-editing.md, B1).
 *
 * three.js: MIT License, Copyright © 2010-2026 three.js authors.
 */

const made = new WeakMap();

/** The wide-line classes for `THREE`, made once per three.js. */
export function wideLines(THREE) {
  let classes = made.get(THREE);
  if (classes) return classes;
  const { Box3, Float32BufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute, Line3, MathUtils, Matrix4, Mesh, ShaderLib, ShaderMaterial, Sphere, UniformsLib, UniformsUtils, Vector2, Vector3, Vector4, WireframeGeometry } = THREE;

  // ── LineSegmentsGeometry.js, in a scope of its own ──
  const LineSegmentsGeometry = (() => {
    const _box = new Box3();
    const _vector = new Vector3();

    /**
     * A series of vertex pairs, forming line segments.
     *
     * This is used in {@link LineSegments2} to describe the shape.
     *
     * @augments InstancedBufferGeometry
     * @three_import  */
    class LineSegmentsGeometry extends InstancedBufferGeometry {

    	/**
    	 * Constructs a new line segments geometry.
    	 */
    	constructor() {

    		super();

    		/**
    		 * This flag can be used for type testing.
    		 *
    		 * @type {boolean}
    		 * @readonly
    		 * @default true
    		 */
    		this.isLineSegmentsGeometry = true;

    		this.type = 'LineSegmentsGeometry';

    		const positions = [ - 1, 2, 0, 1, 2, 0, - 1, 1, 0, 1, 1, 0, - 1, 0, 0, 1, 0, 0, - 1, - 1, 0, 1, - 1, 0 ];
    		const uvs = [ - 1, 2, 1, 2, - 1, 1, 1, 1, - 1, - 1, 1, - 1, - 1, - 2, 1, - 2 ];
    		const index = [ 0, 2, 1, 2, 3, 1, 2, 4, 3, 4, 5, 3, 4, 6, 5, 6, 7, 5 ];

    		this.setIndex( index );
    		this.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
    		this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

    	}

    	/**
    	 * Applies the given 4x4 transformation matrix to the geometry.
    	 *
    	 * @param {Matrix4} matrix - The matrix to apply.
    	 * @return {LineSegmentsGeometry} A reference to this instance.
    	 */
    	applyMatrix4( matrix ) {

    		const start = this.attributes.instanceStart;
    		const end = this.attributes.instanceEnd;

    		if ( start !== undefined ) {

    			start.applyMatrix4( matrix );

    			end.applyMatrix4( matrix );

    			start.needsUpdate = true;

    		}

    		if ( this.boundingBox !== null ) {

    			this.computeBoundingBox();

    		}

    		if ( this.boundingSphere !== null ) {

    			this.computeBoundingSphere();

    		}

    		return this;

    	}

    	/**
    	 * Sets the given line positions for this geometry. The length must be a multiple of six since
    	 * each line segment is defined by a start end vertex in the pattern `(xyz xyz)`.
    	 *
    	 * @param {Float32Array|Array<number>} array - The position data to set.
    	 * @return {LineSegmentsGeometry} A reference to this geometry.
    	 */
    	setPositions( array ) {

    		let lineSegments;

    		if ( array instanceof Float32Array ) {

    			lineSegments = array;

    		} else if ( Array.isArray( array ) ) {

    			lineSegments = new Float32Array( array );

    		}

    		const instanceBuffer = new InstancedInterleavedBuffer( lineSegments, 6, 1 ); // xyz, xyz

    		this.setAttribute( 'instanceStart', new InterleavedBufferAttribute( instanceBuffer, 3, 0 ) ); // xyz
    		this.setAttribute( 'instanceEnd', new InterleavedBufferAttribute( instanceBuffer, 3, 3 ) ); // xyz

    		this.instanceCount = this.attributes.instanceStart.count;

    		//

    		this.computeBoundingBox();
    		this.computeBoundingSphere();

    		return this;

    	}

    	/**
    	 * Sets the given line colors for this geometry. The length must be a multiple of six since
    	 * each line segment is defined by a start end color in the pattern `(rgb rgb)`.
    	 *
    	 * @param {Float32Array|Array<number>} array - The position data to set.
    	 * @return {LineSegmentsGeometry} A reference to this geometry.
    	 */
    	setColors( array ) {

    		let colors;

    		if ( array instanceof Float32Array ) {

    			colors = array;

    		} else if ( Array.isArray( array ) ) {

    			colors = new Float32Array( array );

    		}

    		const instanceColorBuffer = new InstancedInterleavedBuffer( colors, 6, 1 ); // rgb, rgb

    		this.setAttribute( 'instanceColorStart', new InterleavedBufferAttribute( instanceColorBuffer, 3, 0 ) ); // rgb
    		this.setAttribute( 'instanceColorEnd', new InterleavedBufferAttribute( instanceColorBuffer, 3, 3 ) ); // rgb

    		return this;

    	}

    	/**
    	 * Setups this line segments geometry from the given wireframe geometry.
    	 *
    	 * @param {WireframeGeometry} geometry - The geometry that should be used as a data source for this geometry.
    	 * @return {LineSegmentsGeometry} A reference to this geometry.
    	 */
    	fromWireframeGeometry( geometry ) {

    		this.setPositions( geometry.attributes.position.array );

    		return this;

    	}

    	/**
    	 * Setups this line segments geometry from the given edges geometry.
    	 *
    	 * @param {EdgesGeometry} geometry - The geometry that should be used as a data source for this geometry.
    	 * @return {LineSegmentsGeometry} A reference to this geometry.
    	 */
    	fromEdgesGeometry( geometry ) {

    		this.setPositions( geometry.attributes.position.array );

    		return this;

    	}

    	/**
    	 * Setups this line segments geometry from the given mesh.
    	 *
    	 * @param {Mesh} mesh - The mesh geometry that should be used as a data source for this geometry.
    	 * @return {LineSegmentsGeometry} A reference to this geometry.
    	 */
    	fromMesh( mesh ) {

    		this.fromWireframeGeometry( new WireframeGeometry( mesh.geometry ) );

    		// set colors, maybe

    		return this;

    	}

    	/**
    	 * Setups this line segments geometry from the given line segments.
    	 *
    	 * @param {LineSegments} lineSegments - The line segments that should be used as a data source for this geometry.
    	 * Assumes the source geometry is not using indices.
    	 * @return {LineSegmentsGeometry} A reference to this geometry.
    	 */
    	fromLineSegments( lineSegments ) {

    		const geometry = lineSegments.geometry;

    		this.setPositions( geometry.attributes.position.array ); // assumes non-indexed

    		// set colors, maybe

    		return this;

    	}

    	computeBoundingBox() {

    		if ( this.boundingBox === null ) {

    			this.boundingBox = new Box3();

    		}

    		const start = this.attributes.instanceStart;
    		const end = this.attributes.instanceEnd;

    		if ( start !== undefined && end !== undefined ) {

    			this.boundingBox.setFromBufferAttribute( start );

    			_box.setFromBufferAttribute( end );

    			this.boundingBox.union( _box );

    		}

    	}

    	computeBoundingSphere() {

    		if ( this.boundingSphere === null ) {

    			this.boundingSphere = new Sphere();

    		}

    		if ( this.boundingBox === null ) {

    			this.computeBoundingBox();

    		}

    		const start = this.attributes.instanceStart;
    		const end = this.attributes.instanceEnd;

    		if ( start !== undefined && end !== undefined ) {

    			const center = this.boundingSphere.center;

    			this.boundingBox.getCenter( center );

    			let maxRadiusSq = 0;

    			for ( let i = 0, il = start.count; i < il; i ++ ) {

    				_vector.fromBufferAttribute( start, i );
    				maxRadiusSq = Math.max( maxRadiusSq, center.distanceToSquared( _vector ) );

    				_vector.fromBufferAttribute( end, i );
    				maxRadiusSq = Math.max( maxRadiusSq, center.distanceToSquared( _vector ) );

    			}

    			this.boundingSphere.radius = Math.sqrt( maxRadiusSq );

    			if ( isNaN( this.boundingSphere.radius ) ) {

    				console.error( 'THREE.LineSegmentsGeometry.computeBoundingSphere(): Computed radius is NaN. The instanced position data is likely to have NaN values.', this );

    			}

    		}

    	}

    	toJSON() {

    		// todo

    	}

    }

    return LineSegmentsGeometry;
  })();

  // ── LineMaterial.js, in a scope of its own ──
  const LineMaterial = (() => {
    UniformsLib.line = {

    	worldUnits: { value: 1 },
    	linewidth: { value: 1 },
    	resolution: { value: new Vector2() },
    	dashOffset: { value: 0 },
    	dashScale: { value: 1 },
    	dashSize: { value: 1 },
    	gapSize: { value: 1 } // todo FIX - maybe change to totalSize

    };

    ShaderLib[ 'line' ] = {

    	uniforms: UniformsUtils.merge( [
    		UniformsLib.common,
    		UniformsLib.fog,
    		UniformsLib.line
    	] ),

    	vertexShader:
    	/* glsl */`
    		#include <common>
    		#include <color_pars_vertex>
    		#include <fog_pars_vertex>
    		#include <logdepthbuf_pars_vertex>
    		#include <clipping_planes_pars_vertex>

    		uniform float linewidth;
    		uniform vec2 resolution;

    		attribute vec3 instanceStart;
    		attribute vec3 instanceEnd;

    		attribute vec3 instanceColorStart;
    		attribute vec3 instanceColorEnd;

    		#ifdef WORLD_UNITS

    			varying vec4 worldPos;
    			varying vec3 worldStart;
    			varying vec3 worldEnd;

    			#ifdef USE_DASH

    				varying vec2 vUv;

    			#endif

    		#else

    			varying vec2 vUv;

    		#endif

    		#ifdef USE_DASH

    			uniform float dashScale;
    			attribute float instanceDistanceStart;
    			attribute float instanceDistanceEnd;
    			varying float vLineDistance;

    		#endif

    		float trimSegmentAlpha( const in vec4 start, const in vec4 end ) {

    			// compute the interpolation factor needed to trim the segment so it terminates
    			// between the camera plane and the near plane

    			// conservative estimate of the near plane
    			float a = projectionMatrix[ 2 ][ 2 ]; // 3nd entry in 3th column
    			float b = projectionMatrix[ 3 ][ 2 ]; // 3nd entry in 4th column

    			// we need different nearEstimate formula for reversed and default depth buffer
    			// a is positive with a reversed depth buffer so it can be used for controlling the code flow
    			float nearEstimate = ( a > 0.0 ) ? ( - b / ( a + 1.0 ) ) : ( - 0.5 * b / a );

    			return ( nearEstimate - start.z ) / ( end.z - start.z );

    		}

    		void main() {

    			#ifdef USE_COLOR

    				vColor.xyz = ( position.y < 0.5 ) ? instanceColorStart : instanceColorEnd;

    			#endif

    			float aspect = resolution.x / resolution.y;

    			// camera space
    			vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
    			vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

    			#ifdef USE_DASH

    				float lineDistanceStart = dashScale * instanceDistanceStart;
    				float lineDistanceEnd = dashScale * instanceDistanceEnd;

    			#endif

    			#ifdef WORLD_UNITS

    				worldStart = start.xyz;
    				worldEnd = end.xyz;

    			#else

    				vUv = uv;

    			#endif

    			// special case for perspective projection, and segments that terminate either in, or behind, the camera plane
    			// clearly the gpu firmware has a way of addressing this issue when projecting into ndc space
    			// but we need to perform ndc-space calculations in the shader, so we must address this issue directly
    			// perhaps there is a more elegant solution -- WestLangley

    			bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ); // 4th entry in the 3rd column

    			if ( perspective ) {

    				if ( start.z < 0.0 && end.z >= 0.0 ) {

    					float alpha = trimSegmentAlpha( start, end );
    					end.xyz = mix( start.xyz, end.xyz, alpha );

    					#ifdef USE_DASH

    						lineDistanceEnd = mix( lineDistanceStart, lineDistanceEnd, alpha );

    					#endif

    				} else if ( end.z < 0.0 && start.z >= 0.0 ) {

    					float alpha = trimSegmentAlpha( end, start );
    					start.xyz = mix( end.xyz, start.xyz, alpha );

    					#ifdef USE_DASH

    						lineDistanceStart = mix( lineDistanceEnd, lineDistanceStart, alpha );

    					#endif

    				}

    			}

    			#ifdef USE_DASH

    				vLineDistance = ( position.y < 0.5 ) ? lineDistanceStart : lineDistanceEnd;
    				vUv = uv;

    			#endif

    			// clip space
    			vec4 clipStart = projectionMatrix * start;
    			vec4 clipEnd = projectionMatrix * end;

    			// ndc space
    			vec3 ndcStart = clipStart.xyz / clipStart.w;
    			vec3 ndcEnd = clipEnd.xyz / clipEnd.w;

    			// direction
    			vec2 dir = ndcEnd.xy - ndcStart.xy;

    			// account for clip-space aspect ratio
    			dir.x *= aspect;
    			dir = normalize( dir );

    			#ifdef WORLD_UNITS

    				vec3 worldDir = normalize( end.xyz - start.xyz );
    				vec3 tmpFwd = normalize( mix( start.xyz, end.xyz, 0.5 ) );
    				vec3 worldUp = normalize( cross( worldDir, tmpFwd ) );
    				vec3 worldFwd = cross( worldDir, worldUp );
    				worldPos = position.y < 0.5 ? start: end;

    				// height offset
    				float hw = linewidth * 0.5;
    				worldPos.xyz += position.x < 0.0 ? hw * worldUp : - hw * worldUp;

    				// don't extend the line if we're rendering dashes because we
    				// won't be rendering the endcaps
    				#ifndef USE_DASH

    					// cap extension
    					worldPos.xyz += position.y < 0.5 ? - hw * worldDir : hw * worldDir;

    					// add width to the box
    					worldPos.xyz += worldFwd * hw;

    					// endcaps
    					if ( position.y > 1.0 || position.y < 0.0 ) {

    						worldPos.xyz -= worldFwd * 2.0 * hw;

    					}

    				#endif

    				// project the worldpos
    				vec4 clip = projectionMatrix * worldPos;

    				// shift the depth of the projected points so the line
    				// segments overlap neatly
    				vec3 clipPose = ( position.y < 0.5 ) ? ndcStart : ndcEnd;
    				clip.z = clipPose.z * clip.w;

    			#else

    				vec2 offset = vec2( dir.y, - dir.x );
    				// undo aspect ratio adjustment
    				dir.x /= aspect;
    				offset.x /= aspect;

    				// sign flip
    				if ( position.x < 0.0 ) offset *= - 1.0;

    				// endcaps
    				if ( position.y < 0.0 ) {

    					offset += - dir;

    				} else if ( position.y > 1.0 ) {

    					offset += dir;

    				}

    				// adjust for linewidth
    				offset *= linewidth;

    				// adjust for clip-space to screen-space conversion // maybe resolution should be based on viewport ...
    				offset /= resolution.y;

    				// select end
    				vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

    				// back to clip space
    				offset *= clip.w;

    				clip.xy += offset;

    			#endif

    			gl_Position = clip;

    			vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation

    			#include <logdepthbuf_vertex>
    			#include <clipping_planes_vertex>
    			#include <fog_vertex>

    		}
    		`,

    	fragmentShader:
    	/* glsl */`
    		uniform vec3 diffuse;
    		uniform float opacity;
    		uniform float linewidth;

    		#ifdef USE_DASH

    			uniform float dashOffset;
    			uniform float dashSize;
    			uniform float gapSize;

    		#endif

    		varying float vLineDistance;

    		#ifdef WORLD_UNITS

    			varying vec4 worldPos;
    			varying vec3 worldStart;
    			varying vec3 worldEnd;

    			#ifdef USE_DASH

    				varying vec2 vUv;

    			#endif

    		#else

    			varying vec2 vUv;

    		#endif

    		#include <common>
    		#include <color_pars_fragment>
    		#include <fog_pars_fragment>
    		#include <logdepthbuf_pars_fragment>
    		#include <clipping_planes_pars_fragment>

    		vec2 closestLineToLine(vec3 p1, vec3 p2, vec3 p3, vec3 p4) {

    			float mua;
    			float mub;

    			vec3 p13 = p1 - p3;
    			vec3 p43 = p4 - p3;

    			vec3 p21 = p2 - p1;

    			float d1343 = dot( p13, p43 );
    			float d4321 = dot( p43, p21 );
    			float d1321 = dot( p13, p21 );
    			float d4343 = dot( p43, p43 );
    			float d2121 = dot( p21, p21 );

    			float denom = d2121 * d4343 - d4321 * d4321;

    			float numer = d1343 * d4321 - d1321 * d4343;

    			mua = numer / denom;
    			mua = clamp( mua, 0.0, 1.0 );
    			mub = ( d1343 + d4321 * ( mua ) ) / d4343;
    			mub = clamp( mub, 0.0, 1.0 );

    			return vec2( mua, mub );

    		}

    		void main() {

    			float alpha = opacity;
    			vec4 diffuseColor = vec4( diffuse, alpha );

    			#include <clipping_planes_fragment>

    			#ifdef USE_DASH

    				if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps

    				if ( mod( vLineDistance + dashOffset, dashSize + gapSize ) > dashSize ) discard; // todo - FIX

    			#endif

    			#ifdef WORLD_UNITS

    				// Find the closest points on the view ray and the line segment
    				vec3 rayEnd = normalize( worldPos.xyz ) * 1e5;
    				vec3 lineDir = worldEnd - worldStart;
    				vec2 params = closestLineToLine( worldStart, worldEnd, vec3( 0.0, 0.0, 0.0 ), rayEnd );

    				vec3 p1 = worldStart + lineDir * params.x;
    				vec3 p2 = rayEnd * params.y;
    				vec3 delta = p1 - p2;
    				float len = length( delta );
    				float norm = len / linewidth;

    				#ifndef USE_DASH

    					#ifdef USE_ALPHA_TO_COVERAGE

    						float dnorm = fwidth( norm );
    						alpha = 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm );

    					#else

    						if ( norm > 0.5 ) {

    							discard;

    						}

    					#endif

    				#endif

    			#else

    				#ifdef USE_ALPHA_TO_COVERAGE

    					// artifacts appear on some hardware if a derivative is taken within a conditional
    					float a = vUv.x;
    					float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
    					float len2 = a * a + b * b;
    					float dlen = fwidth( len2 );

    					if ( abs( vUv.y ) > 1.0 ) {

    						alpha = 1.0 - smoothstep( 1.0 - dlen, 1.0 + dlen, len2 );

    					}

    				#else

    					if ( abs( vUv.y ) > 1.0 ) {

    						float a = vUv.x;
    						float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
    						float len2 = a * a + b * b;

    						if ( len2 > 1.0 ) discard;

    					}

    				#endif

    			#endif

    			#include <logdepthbuf_fragment>
    			#include <color_fragment>

    			gl_FragColor = vec4( diffuseColor.rgb, alpha );

    			#include <tonemapping_fragment>
    			#include <colorspace_fragment>
    			#include <fog_fragment>
    			#include <premultiplied_alpha_fragment>

    		}
    		`
    };

    /**
     * A material for drawing wireframe-style geometries.
     *
     * Unlike {@link LineBasicMaterial}, it supports arbitrary line widths and allows using world units
     * instead of screen space units. This material is used with {@link LineSegments2} and {@link Line2}.
     *
     * This module can only be used with {@link WebGLRenderer}. When using {@link WebGPURenderer},
     * use {@link Line2NodeMaterial}.
     *
     * @augments ShaderMaterial
     * @three_import  */
    class LineMaterial extends ShaderMaterial {

    	/**
    	 * Constructs a new line segments geometry.
    	 *
    	 * @param {Object} [parameters] - An object with one or more properties
    	 * defining the material's appearance. Any property of the material
    	 * (including any property from inherited materials) can be passed
    	 * in here. Color values can be passed any type of value accepted
    	 * by {@link Color#set}.
    	 */
    	constructor( parameters ) {

    		super( {

    			type: 'LineMaterial',
    			uniforms: UniformsUtils.clone( ShaderLib[ 'line' ].uniforms ),

    			vertexShader: ShaderLib[ 'line' ].vertexShader,
    			fragmentShader: ShaderLib[ 'line' ].fragmentShader,

    			clipping: true // required for clipping support

    		} );

    		/**
    		 * This flag can be used for type testing.
    		 *
    		 * @type {boolean}
    		 * @readonly
    		 * @default true
    		 */
    		this.isLineMaterial = true;

    		this.setValues( parameters );

    	}

    	/**
    	 * The material's color.
    	 *
    	 * @type {Color}
    	 * @default (1,1,1)
    	 */
    	get color() {

    		return this.uniforms.diffuse.value;

    	}

    	set color( value ) {

    		this.uniforms.diffuse.value = value;

    	}

    	/**
    	 * Whether the material's sizes (width, dash gaps) are in world units.
    	 *
    	 * @type {boolean}
    	 * @default false
    	 */
    	get worldUnits() {

    		return 'WORLD_UNITS' in this.defines;

    	}

    	set worldUnits( value ) {

    		if ( ( value === true ) !== this.worldUnits ) {

    			this.needsUpdate = true;

    		}

    		if ( value === true ) {

    			this.defines.WORLD_UNITS = '';

    		} else {

    			delete this.defines.WORLD_UNITS;

    		}

    	}

    	/**
    	 * Controls line thickness in CSS pixel units when `worldUnits` is `false` (default),
    	 * or in world units when `worldUnits` is `true`.
    	 *
    	 * @type {number}
    	 * @default 1
    	 */
    	get linewidth() {

    		return this.uniforms.linewidth.value;

    	}

    	set linewidth( value ) {

    		if ( ! this.uniforms.linewidth ) return;
    		this.uniforms.linewidth.value = value;

    	}

    	/**
    	 * Whether the line is dashed, or solid.
    	 *
    	 * @type {boolean}
    	 * @default false
    	 */
    	get dashed() {

    		return 'USE_DASH' in this.defines;

    	}

    	set dashed( value ) {

    		if ( ( value === true ) !== this.dashed ) {

    			this.needsUpdate = true;

    		}

    		if ( value === true ) {

    			this.defines.USE_DASH = '';

    		} else {

    			delete this.defines.USE_DASH;

    		}

    	}

    	/**
    	 * The scale of the dashes and gaps.
    	 *
    	 * @type {number}
    	 * @default 1
    	 */
    	get dashScale() {

    		return this.uniforms.dashScale.value;

    	}

    	set dashScale( value ) {

    		this.uniforms.dashScale.value = value;

    	}

    	/**
    	 * The size of the dash.
    	 *
    	 * @type {number}
    	 * @default 1
    	 */
    	get dashSize() {

    		return this.uniforms.dashSize.value;

    	}

    	set dashSize( value ) {

    		this.uniforms.dashSize.value = value;

    	}

    	/**
    	 * Where in the dash cycle the dash starts.
    	 *
    	 * @type {number}
    	 * @default 0
    	 */
    	get dashOffset() {

    		return this.uniforms.dashOffset.value;

    	}

    	set dashOffset( value ) {

    		this.uniforms.dashOffset.value = value;

    	}

    	/**
    	 * The size of the gap.
    	 *
    	 * @type {number}
    	 * @default 0
    	 */
    	get gapSize() {

    		return this.uniforms.gapSize.value;

    	}

    	set gapSize( value ) {

    		this.uniforms.gapSize.value = value;

    	}

    	/**
    	 * The opacity.
    	 *
    	 * @type {number}
    	 * @default 1
    	 */
    	get opacity() {

    		return this.uniforms.opacity.value;

    	}

    	set opacity( value ) {

    		if ( ! this.uniforms ) return;
    		this.uniforms.opacity.value = value;

    	}

    	/**
    	 * The size of the viewport, in screen pixels. This must be kept updated to make
    	 * screen-space rendering accurate. The `LineSegments2.onBeforeRender` callback
    	 * performs the update for visible objects.
    	 *
    	 * @type {Vector2}
    	 */
    	get resolution() {

    		return this.uniforms.resolution.value;

    	}

    	set resolution( value ) {

    		this.uniforms.resolution.value.copy( value );

    	}

    	/**
    	 * Whether to use alphaToCoverage or not. When enabled, this can improve the
    	 * anti-aliasing of line edges when using MSAA.
    	 *
    	 * @type {boolean}
    	 */
    	get alphaToCoverage() {

    		return 'USE_ALPHA_TO_COVERAGE' in this.defines;

    	}

    	set alphaToCoverage( value ) {

    		if ( ! this.defines ) return;

    		if ( ( value === true ) !== this.alphaToCoverage ) {

    			this.needsUpdate = true;

    		}

    		if ( value === true ) {

    			this.defines.USE_ALPHA_TO_COVERAGE = '';

    		} else {

    			delete this.defines.USE_ALPHA_TO_COVERAGE;

    		}

    	}

    }

    return LineMaterial;
  })();

  // ── LineSegments2.js, in a scope of its own ──
  const LineSegments2 = (() => {
    const _viewport = new Vector4();

    const _start = new Vector3();
    const _end = new Vector3();

    const _start4 = new Vector4();
    const _end4 = new Vector4();

    const _ssOrigin = new Vector4();
    const _ssOrigin3 = new Vector3();
    const _mvMatrix = new Matrix4();
    const _line = new Line3();
    const _closestPoint = new Vector3();

    const _box = new Box3();
    const _sphere = new Sphere();
    const _clipToWorldVector = new Vector4();

    let _ray, _lineWidth;

    // Returns the margin required to expand by in world space given the distance from the camera,
    // line width, resolution, and camera projection
    function getWorldSpaceHalfWidth( camera, distance, resolution ) {

    	// transform into clip space, adjust the x and y values by the pixel width offset, then
    	// transform back into world space to get world offset. Note clip space is [-1, 1] so full
    	// width does not need to be halved.
    	_clipToWorldVector.set( 0, 0, - distance, 1.0 ).applyMatrix4( camera.projectionMatrix );
    	_clipToWorldVector.multiplyScalar( 1.0 / _clipToWorldVector.w );
    	_clipToWorldVector.x = _lineWidth / resolution.width;
    	_clipToWorldVector.y = _lineWidth / resolution.height;
    	_clipToWorldVector.applyMatrix4( camera.projectionMatrixInverse );
    	_clipToWorldVector.multiplyScalar( 1.0 / _clipToWorldVector.w );

    	return Math.abs( Math.max( _clipToWorldVector.x, _clipToWorldVector.y ) );

    }

    function raycastWorldUnits( lineSegments, intersects ) {

    	const matrixWorld = lineSegments.matrixWorld;
    	const geometry = lineSegments.geometry;
    	const instanceStart = geometry.attributes.instanceStart;
    	const instanceEnd = geometry.attributes.instanceEnd;
    	const segmentCount = Math.min( geometry.instanceCount, instanceStart.count );

    	for ( let i = 0, l = segmentCount; i < l; i ++ ) {

    		_line.start.fromBufferAttribute( instanceStart, i );
    		_line.end.fromBufferAttribute( instanceEnd, i );

    		_line.applyMatrix4( matrixWorld );

    		const pointOnLine = new Vector3();
    		const point = new Vector3();

    		_ray.distanceSqToSegment( _line.start, _line.end, point, pointOnLine );
    		const isInside = point.distanceTo( pointOnLine ) < _lineWidth * 0.5;

    		if ( isInside ) {

    			intersects.push( {
    				point,
    				pointOnLine,
    				distance: _ray.origin.distanceTo( point ),
    				object: lineSegments,
    				face: null,
    				faceIndex: i,
    				uv: null,
    				uv1: null,
    			} );

    		}

    	}

    }

    function raycastScreenSpace( lineSegments, camera, intersects ) {

    	const projectionMatrix = camera.projectionMatrix;
    	const material = lineSegments.material;
    	const resolution = material.resolution;
    	const matrixWorld = lineSegments.matrixWorld;

    	const geometry = lineSegments.geometry;
    	const instanceStart = geometry.attributes.instanceStart;
    	const instanceEnd = geometry.attributes.instanceEnd;
    	const segmentCount = Math.min( geometry.instanceCount, instanceStart.count );

    	const near = - camera.near;

    	//

    	// pick a point 1 unit out along the ray to avoid the ray origin
    	// sitting at the camera origin which will cause "w" to be 0 when
    	// applying the projection matrix.
    	_ray.at( 1, _ssOrigin );

    	// ndc space [ - 1.0, 1.0 ]
    	_ssOrigin.w = 1;
    	_ssOrigin.applyMatrix4( camera.matrixWorldInverse );
    	_ssOrigin.applyMatrix4( projectionMatrix );
    	_ssOrigin.multiplyScalar( 1 / _ssOrigin.w );

    	// screen space
    	_ssOrigin.x *= resolution.x / 2;
    	_ssOrigin.y *= resolution.y / 2;
    	_ssOrigin.z = 0;

    	_ssOrigin3.copy( _ssOrigin );

    	_mvMatrix.multiplyMatrices( camera.matrixWorldInverse, matrixWorld );

    	for ( let i = 0, l = segmentCount; i < l; i ++ ) {

    		_start4.fromBufferAttribute( instanceStart, i );
    		_end4.fromBufferAttribute( instanceEnd, i );

    		_start4.w = 1;
    		_end4.w = 1;

    		// camera space
    		_start4.applyMatrix4( _mvMatrix );
    		_end4.applyMatrix4( _mvMatrix );

    		// skip the segment if it's entirely behind the camera
    		const isBehindCameraNear = _start4.z > near && _end4.z > near;
    		if ( isBehindCameraNear ) {

    			continue;

    		}

    		// trim the segment if it extends behind camera near
    		if ( _start4.z > near ) {

    			const deltaDist = _start4.z - _end4.z;
    			const t = ( _start4.z - near ) / deltaDist;
    			_start4.lerp( _end4, t );

    		} else if ( _end4.z > near ) {

    			const deltaDist = _end4.z - _start4.z;
    			const t = ( _end4.z - near ) / deltaDist;
    			_end4.lerp( _start4, t );

    		}

    		// clip space
    		_start4.applyMatrix4( projectionMatrix );
    		_end4.applyMatrix4( projectionMatrix );

    		// ndc space [ - 1.0, 1.0 ]
    		_start4.multiplyScalar( 1 / _start4.w );
    		_end4.multiplyScalar( 1 / _end4.w );

    		// screen space
    		_start4.x *= resolution.x / 2;
    		_start4.y *= resolution.y / 2;

    		_end4.x *= resolution.x / 2;
    		_end4.y *= resolution.y / 2;

    		// create 2d segment
    		_line.start.copy( _start4 );
    		_line.start.z = 0;

    		_line.end.copy( _end4 );
    		_line.end.z = 0;

    		// get closest point on ray to segment
    		const param = _line.closestPointToPointParameter( _ssOrigin3, true );
    		_line.at( param, _closestPoint );

    		// check if the intersection point is within clip space
    		const zPos = MathUtils.lerp( _start4.z, _end4.z, param );
    		const isInClipSpace = zPos >= - 1 && zPos <= 1;

    		const isInside = _ssOrigin3.distanceTo( _closestPoint ) < _lineWidth * 0.5;

    		if ( isInClipSpace && isInside ) {

    			_line.start.fromBufferAttribute( instanceStart, i );
    			_line.end.fromBufferAttribute( instanceEnd, i );

    			_line.start.applyMatrix4( matrixWorld );
    			_line.end.applyMatrix4( matrixWorld );

    			const pointOnLine = new Vector3();
    			const point = new Vector3();

    			_ray.distanceSqToSegment( _line.start, _line.end, point, pointOnLine );

    			intersects.push( {
    				point: point,
    				pointOnLine: pointOnLine,
    				distance: _ray.origin.distanceTo( point ),
    				object: lineSegments,
    				face: null,
    				faceIndex: i,
    				uv: null,
    				uv1: null,
    			} );

    		}

    	}

    }

    /**
     * A series of lines drawn between pairs of vertices.
     *
     * This adds functionality beyond {@link LineSegments}, like arbitrary line width and changing width
     * to be in world units. {@link Line2} extends this object, forming a polyline instead of individual
     * segments.
     *
     * This module can only be used with {@link WebGLRenderer}. When using {@link WebGPURenderer},
     * import the class from `lines/webgpu/LineSegments2.js`.
     *
     *  ```js
     * const geometry = new LineSegmentsGeometry();
     * geometry.setPositions( positions );
     * geometry.setColors( colors );
     *
     * const material = new LineMaterial( { linewidth: 5, vertexColors: true } };
     *
     * const lineSegments = new LineSegments2( geometry, material );
     * scene.add( lineSegments );
     * ```
     *
     * @augments Mesh
     * @three_import  */
    class LineSegments2 extends Mesh {

    	/**
    	 * Constructs a new wide line.
    	 *
    	 * @param {LineSegmentsGeometry} [geometry] - The line geometry.
    	 * @param {LineMaterial} [material] - The line material.
    	 */
    	constructor( geometry = new LineSegmentsGeometry(), material = new LineMaterial( { color: Math.random() * 0xffffff } ) ) {

    		super( geometry, material );

    		/**
    		 * This flag can be used for type testing.
    		 *
    		 * @type {boolean}
    		 * @readonly
    		 * @default true
    		 */
    		this.isLineSegments2 = true;

    		this.type = 'LineSegments2';

    	}

    	/**
    	 * Computes an array of distance values which are necessary for rendering dashed lines.
    	 * For each vertex in the geometry, the method calculates the cumulative length from the
    	 * current point to the very beginning of the line.
    	 *
    	 * @return {LineSegments2} A reference to this instance.
    	 */
    	computeLineDistances() {

    		// for backwards-compatibility, but could be a method of LineSegmentsGeometry...

    		const geometry = this.geometry;

    		const instanceStart = geometry.attributes.instanceStart;
    		const instanceEnd = geometry.attributes.instanceEnd;
    		const lineDistances = new Float32Array( 2 * instanceStart.count );

    		for ( let i = 0, j = 0, l = instanceStart.count; i < l; i ++, j += 2 ) {

    			_start.fromBufferAttribute( instanceStart, i );
    			_end.fromBufferAttribute( instanceEnd, i );

    			lineDistances[ j ] = ( j === 0 ) ? 0 : lineDistances[ j - 1 ];
    			lineDistances[ j + 1 ] = lineDistances[ j ] + _start.distanceTo( _end );

    		}

    		const instanceDistanceBuffer = new InstancedInterleavedBuffer( lineDistances, 2, 1 ); // d0, d1

    		geometry.setAttribute( 'instanceDistanceStart', new InterleavedBufferAttribute( instanceDistanceBuffer, 1, 0 ) ); // d0
    		geometry.setAttribute( 'instanceDistanceEnd', new InterleavedBufferAttribute( instanceDistanceBuffer, 1, 1 ) ); // d1

    		return this;

    	}

    	/**
    	 * Computes intersection points between a casted ray and this instance.
    	 *
    	 * @param {Raycaster} raycaster - The raycaster.
    	 * @param {Array<Object>} intersects - The target array that holds the intersection points.
    	 */
    	raycast( raycaster, intersects ) {

    		const worldUnits = this.material.worldUnits;
    		const camera = raycaster.camera;

    		if ( camera === null && ! worldUnits ) {

    			console.error( 'LineSegments2: "Raycaster.camera" needs to be set in order to raycast against LineSegments2 while worldUnits is set to false.' );

    		}

    		// early out if no resolution has been set (line was not rendered yet)

    		if ( worldUnits === false && ( this.material.resolution.x === 0 || this.material.resolution.y === 0 ) ) {

    			return;

    		}

    		const threshold = ( raycaster.params.Line2 !== undefined ) ? raycaster.params.Line2.threshold || 0 : 0;

    		_ray = raycaster.ray;

    		const matrixWorld = this.matrixWorld;
    		const geometry = this.geometry;
    		const material = this.material;

    		_lineWidth = material.linewidth + threshold;

    		// check if we intersect the sphere bounds
    		if ( geometry.boundingSphere === null ) {

    			geometry.computeBoundingSphere();

    		}

    		_sphere.copy( geometry.boundingSphere ).applyMatrix4( matrixWorld );

    		// increase the sphere bounds by the worst case line screen space width
    		let sphereMargin;
    		if ( worldUnits ) {

    			sphereMargin = _lineWidth * 0.5;

    		} else {

    			const distanceToSphere = Math.max( camera.near, _sphere.distanceToPoint( _ray.origin ) );
    			sphereMargin = getWorldSpaceHalfWidth( camera, distanceToSphere, material.resolution );

    		}

    		_sphere.radius += sphereMargin;

    		if ( _ray.intersectsSphere( _sphere ) === false ) {

    			return;

    		}

    		// check if we intersect the box bounds
    		if ( geometry.boundingBox === null ) {

    			geometry.computeBoundingBox();

    		}

    		_box.copy( geometry.boundingBox ).applyMatrix4( matrixWorld );

    		// increase the box bounds by the worst case line width
    		let boxMargin;
    		if ( worldUnits ) {

    			boxMargin = _lineWidth * 0.5;

    		} else {

    			const distanceToBox = Math.max( camera.near, _box.distanceToPoint( _ray.origin ) );
    			boxMargin = getWorldSpaceHalfWidth( camera, distanceToBox, material.resolution );

    		}

    		_box.expandByScalar( boxMargin );

    		if ( _ray.intersectsBox( _box ) === false ) {

    			return;

    		}

    		if ( worldUnits ) {

    			raycastWorldUnits( this, intersects );

    		} else {

    			raycastScreenSpace( this, camera, intersects );

    		}

    	}

    	onBeforeRender( renderer ) {

    		const uniforms = this.material.uniforms;

    		if ( uniforms && uniforms.resolution ) {

    			renderer.getViewport( _viewport );
    			this.material.uniforms.resolution.value.set( _viewport.z, _viewport.w );

    		}

    	}

    }

    return LineSegments2;
  })();

  classes = { LineSegmentsGeometry, LineMaterial, LineSegments2 };
  made.set(THREE, classes);
  return classes;
}
