/**
 * aframe-blueprint-shader.js
 *
 * <a-scene blueprint-renderer="edgeColor: #00cfff; bgColor: #020b18; edgeStrength: 1.2">
 * <a-entity gltf-model="..." blueprint-object></a-entity>
 */

const BP_VERT_GBUF = `
  varying vec3  vNormal;
  varying float vDepth;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position,1.0);
    gl_Position = projectionMatrix * mv;
    vNormal = normalize(normalMatrix * normal);
    vDepth  = clamp((-mv.z - 0.1) / 200.0, 0.0, 1.0);
  }
`;
const BP_FRAG_GBUF = `
  precision highp float;
  varying vec3  vNormal;
  varying float vDepth;
  void main(){
    gl_FragColor = vec4(vNormal * 0.5 + 0.5, vDepth);
  }
`;

const BP_FRAG_QUAD = `
  precision highp float;
  uniform sampler2D uGBuf;
  uniform vec2      uTexel;
  uniform vec3      uEdgeColor;
  uniform vec3      uBgColor;
  uniform float     uEdgeStrength;
  varying vec2      vUv;

  float sobel(vec2 uv){
    vec4 tl=texture2D(uGBuf,uv+vec2(-uTexel.x, uTexel.y));
    vec4 tc=texture2D(uGBuf,uv+vec2(      0.0, uTexel.y));
    vec4 tr=texture2D(uGBuf,uv+vec2( uTexel.x, uTexel.y));
    vec4 ml=texture2D(uGBuf,uv+vec2(-uTexel.x,      0.0));
    vec4 mr=texture2D(uGBuf,uv+vec2( uTexel.x,      0.0));
    vec4 bl=texture2D(uGBuf,uv+vec2(-uTexel.x,-uTexel.y));
    vec4 bc=texture2D(uGBuf,uv+vec2(      0.0,-uTexel.y));
    vec4 br=texture2D(uGBuf,uv+vec2( uTexel.x,-uTexel.y));
    vec4 sx = -tl-2.0*ml-bl+tr+2.0*mr+br;
    vec4 sy = -tl-2.0*tc-tr+bl+2.0*bc+br;
    return clamp((length(sx.rgb)+length(sy.rgb)+(abs(sx.a)+abs(sy.a))*15.0)*uEdgeStrength,0.0,1.0);
  }

  void main(){
    float a = texture2D(uGBuf, vUv).a;
    if(a < 0.0001) { gl_FragColor = vec4(0.0); return; } /* kein Blueprint-Pixel → transparent */
    float e = sobel(vUv);
    gl_FragColor = vec4(mix(uBgColor, uEdgeColor, e), 1.0);
  }
`;

const BP_VERT_QUAD = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position,1.0); }
`;

/* ── blueprint-object: Mesh als Blueprint markieren ── */
AFRAME.registerComponent('blueprint-object', {
  init() {
    const apply = () => {
      this.el.object3D.traverse(n => {
        if (!n.isMesh) return;
        n.__isBP     = true;
        n.__bpOrig   = n.material;
        n.__bpGMat   = n.__bpGMat || new THREE.ShaderMaterial({
          vertexShader: BP_VERT_GBUF, fragmentShader: BP_FRAG_GBUF
        });
      });
    };
    this.el.addEventListener('object3dset', apply);
    apply();
  },
  remove() {
    this.el.object3D.traverse(n => {
      if (!n.__isBP) return;
      n.material = n.__bpOrig;
      delete n.__isBP; delete n.__bpOrig; delete n.__bpGMat;
    });
  },
});

/* ── blueprint-renderer: an <a-scene> ── */
AFRAME.registerComponent('blueprint-renderer', {
  schema: {
    edgeColor:    { type: 'color',  default: '#00cfff' },
    bgColor:      { type: 'color',  default: '#020b18' },
    edgeStrength: { type: 'number', default: 1.0 },
  },

  init() {
    this.el.addEventListener('renderstart', () => {
      const r  = this.el.renderer;
      const W  = Math.floor(window.innerWidth  * r.getPixelRatio());
      const H  = Math.floor(window.innerHeight * r.getPixelRatio());

      this._gRT = new THREE.WebGLRenderTarget(W, H, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.HalfFloatType,
      });

      this._uni = {
        uGBuf:        { value: this._gRT.texture },
        uTexel:       { value: new THREE.Vector2(1/W, 1/H) },
        uEdgeColor:   { value: new THREE.Color(this.data.edgeColor) },
        uBgColor:     { value: new THREE.Color(this.data.bgColor) },
        uEdgeStrength:{ value: this.data.edgeStrength },
      };

      this._quad = new THREE.Scene();
      this._quad.add(new THREE.Mesh(
        new THREE.PlaneGeometry(2,2),
        new THREE.ShaderMaterial({
          uniforms: this._uni,
          vertexShader: BP_VERT_QUAD, fragmentShader: BP_FRAG_QUAD,
          transparent: true,   /* Blueprint-Pass über die normale Szene legen */
          depthTest: false, depthWrite: false,
        })
      ));
      this._qCam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);

      window.addEventListener('resize', () => {
        const W2 = Math.floor(window.innerWidth  * r.getPixelRatio());
        const H2 = Math.floor(window.innerHeight * r.getPixelRatio());
        this._gRT.setSize(W2, H2);
        this._uni.uTexel.value.set(1/W2, 1/H2);
      });

      const orig = r.render.bind(r);
      r.render = (scene, cam) => {
        const bpMeshes = [];
        scene.traverse(n => { if (n.isMesh && n.__isBP) bpMeshes.push(n); });

        /* Pass 1: normale Szene direkt auf den Screen */
        r.setRenderTarget(null);
        orig(scene, cam);

        if (!bpMeshes.length) return;

        /* Pass 2: G-Buffer mit Blueprint-Material */
        bpMeshes.forEach(n => { n.material = n.__bpGMat; });
        r.setRenderTarget(this._gRT);
        r.setClearColor(0x000000, 0); r.clear(true,true,true);
        orig(scene, cam);
        bpMeshes.forEach(n => { n.material = n.__bpOrig; });

        /* Pass 3: Sobel-Quad transparent über den Screen */
        r.setRenderTarget(null);
        orig(this._quad, this._qCam);
      };
    });
  },
});