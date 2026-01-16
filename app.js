/************
 * Helpers
 ************/
const log = (m, ...r) => console.log(`[ar] ${m}`, ...r);

const waitEvent = (el, name, {once=true, timeoutMs=15000}={}) =>
  new Promise((res, rej) => {
    let to;
    const on = () => { if (to) clearTimeout(to); el.removeEventListener(name, on); res(); };
    el.addEventListener(name, on, {once});
    if (timeoutMs) to = setTimeout(() => { el.removeEventListener(name, on); rej(new Error(`timeout:${name}`)); }, timeoutMs);
  });

/********************************************
 * Composant : png-sequence (auto-count) + ready event
 ********************************************/
if (!AFRAME.components['png-sequence']) {
  AFRAME.registerComponent('png-sequence', {
    schema: {
      prefix:    { type: 'string' },        // ./animations/targetX/frame_
      fps:       { type: 'number', default: 12 },
      pad:       { type: 'int',    default: 3 },   // 000-999
      start:     { type: 'int',    default: 0 },
      max:       { type: 'int',    default: 300 },
      unitWidth: { type: 'number', default: 1 },
      fit:       { type: 'string', default: 'width' } // 'width' | 'height'
    },

    async init() {
      this.playing = false;
      this.frame = 0;
      this.elapsed = 0;
      this.duration = 1000 / this.data.fps;
      this.frames = [];
      this.ready = false;
      this.deferStart = false;

      await new Promise(res => (this.el.hasLoaded ? res() : this.el.addEventListener('loaded', res, { once: true })));

      const pad = n => n.toString().padStart(this.data.pad, '0');
      let i = this.data.start;

      while (i < this.data.max) {
        const url = `${this.data.prefix}${pad(i)}.png`;
        const ok = await new Promise(resolve => {
          const im = new Image();
          im.onload  = () => resolve(true);
          im.onerror = () => resolve(false);
          im.src = url;
        });
        if (ok) {
          if (this.frames.length === 0) {
            const im = new Image();
            await new Promise(resolve => { im.onload = resolve; im.src = url; });
            const iw = im.naturalWidth  || im.width  || 1;
            const ih = im.naturalHeight || im.height || 1;
            const ratio = ih / iw;

            if (this.data.fit === 'width') {
              const w = this.data.unitWidth, h = w * ratio;
              this.el.setAttribute('width', w);
              this.el.setAttribute('height', h);
            } else {
              const h = this.data.unitWidth, w = h / ratio;
              this.el.setAttribute('width', w);
              this.el.setAttribute('height', h);
            }
            this.el.setAttribute('material', 'transparent: true; alphaTest: 0.01; side: double');
            this.el.setAttribute('src', url); // anti flash blanc
          }
          this.frames.push(url);
          i++;
        } else {
          if (this.frames.length > 0) break;
          i++;
        }
      }

      if (!this.frames.length) {
        log('[png] aucune image trouvée pour', this.data.prefix);
        this.el.emit('png-sequence-ready', {ok:false});
        return;
      }

      // précharge non bloquant
      this.frames.forEach(u => { const im = new Image(); im.src = u; });

      this.ready = true;
      this.el.emit('png-sequence-ready', {ok:true, count:this.frames.length}); // <<< READY
      if (this.deferStart) this._reallyStart();
    },

    _reallyStart() {
      if (!this.ready) { this.deferStart = true; return; }
      this.deferStart = false;
      this.playing = true;
      this.frame = 0;
      this.elapsed = 0;
      this.el.setAttribute('src', this.frames[0]);
    },

    start() { this._reallyStart(); },
    stop()  {
      this.playing = false;
      this.frame = 0;
      if (this.frames.length) this.el.setAttribute('src', this.frames[0]);
    },

    tick(t, dt) {
      if (!this.playing || !this.frames.length) return;
      this.elapsed += dt;
      if (this.elapsed >= this.duration) {
        this.elapsed = 0;
        this.frame = (this.frame + 1) % this.frames.length;
        this.el.setAttribute('src', this.frames[this.frame]);
      }
    }
  });
}

/******************************************************
 * Composant : ar-target-loader (PNG + 3D + AUDIO) avec gating “tout prêt”
 ******************************************************/
if (!AFRAME.components['ar-target-loader']) {
  AFRAME.registerComponent('ar-target-loader', {
    schema: {
      // PNG
      pngPrefix:   { type: 'string', default: '' },
      fps:         { type: 'number', default: 12 },
      unitWidth:   { type: 'number', default: 1 },
      fit:         { type: 'string',  default: 'width' },

      // 3D
      modelsDir:   { type: 'string',  default: '' },
      modelPad:    { type: 'int',     default: 3 },
      modelStart:  { type: 'int',     default: 0 },
      modelMax:    { type: 'int',     default: 30 },
      preferNames: { type: 'string',  default: 'model.glb,scene.glb,index.glb,model.gltf,scene.gltf,index.gltf' },
      modelPos:    { type: 'string',  default: '0 0 0' },
      modelRot:    { type: 'string',  default: '0 0 0' },
      modelScale:  { type: 'string',  default: '1 1 1' },
      animClip:    { type: 'string',  default: '*' },
      animLoop:    { type: 'string',  default: 'repeat' },

      // AUDIO
      audioPrefix: { type: 'string',  default: '' },     // ./audio/targetX/audio_  ou ./audio/targetX/audio
      audioPad:    { type: 'int',     default: 3 },
      audioStart:  { type: 'int',     default: 0 },
      audioMax:    { type: 'int',     default: 50 },
      audioLoop:   { type: 'string',  default: 'all' },  // 'none' | 'all'
      audioVolume: { type: 'number',  default: 1 },
      audioPos:    { type: 'string',  default: '0 0 0' },
      audioNonPos: { type: 'boolean', default: true }    // true = non-positionnel
    },

    async init() {
      const root = this.el;
      this.assets = { png: null, models: [], audio: null, tracks: [], trackIndex: 0 };

      // ————— Préparer promises de readiness —————
      const readyPromises = [];

      // 1) PNG
      if (this.data.pngPrefix) {
        const img = document.createElement('a-image');
        img.setAttribute('visible', 'false');
        img.setAttribute('png-sequence',
          `prefix: ${this.data.pngPrefix}; fps: ${this.data.fps}; unitWidth: ${this.data.unitWidth}; fit: ${this.data.fit}`);
        root.appendChild(img);
        this.assets.png = img;
        // attendre l’événement “png-sequence-ready”
        readyPromises.push(waitEvent(img, 'png-sequence-ready').catch(() => {}));
      }

      // 2) 3D
      const modelReadyPromises = [];
      if (this.data.modelsDir) {
        const dir = this.data.modelsDir.endsWith('/') ? this.data.modelsDir : this.data.modelsDir + '/';
        const preferred = this.data.preferNames.split(',').map(s => s.trim()).filter(Boolean);
        let created = false;

        for (const name of preferred) {
          const url = dir + name;
          const ent = this._createModelEntity(url);
          root.appendChild(ent);
          this.assets.models.push(ent);
          modelReadyPromises.push(waitEvent(ent, 'model-loaded').catch(()=>{}));
          created = true; break;
        }
        if (!created) {
          const pad = n => n.toString().padStart(this.data.modelPad, '0');
          let any = false;
          for (let i = this.data.modelStart; i < this.data.modelMax; i++) {
            const urls = [dir + `model_${pad(i)}.glb`, dir + `model_${pad(i)}.gltf`];
            urls.forEach(url => {
              const ent = this._createModelEntity(url);
              root.appendChild(ent);
              this.assets.models.push(ent);
              modelReadyPromises.push(waitEvent(ent, 'model-loaded').catch(()=>{}));
              any = true;
            });
            if (any) break;
          }
        }
      }
      // même si aucun modèle, on met une promesse résolue pour simplifier
      readyPromises.push(Promise.all(modelReadyPromises).catch(()=>{}));

      // 3) AUDIO — précharger & préparer
      if (this.data.audioPrefix) {
        const audioEnt = document.createElement('a-entity');
        audioEnt.setAttribute('visible', 'false');
        const soundBase = [
          `autoplay: false`,
          `loop: false`,
          `volume: ${this.data.audioVolume}`,
          `positional: ${!this.data.audioNonPos}`,
        ].join('; ');
        audioEnt.setAttribute('sound', soundBase);
        audioEnt.setAttribute('position', this.data.audioPos);
        root.appendChild(audioEnt);
        this.assets.audio = audioEnt;

        readyPromises.push(this._discoverAndPreloadAudio().catch(()=>{}));
      }

      // 4) Quand TOUT est prêt → lever un flag
      this._allReady = false;
      Promise.all(readyPromises).then(() => {
        this._allReady = true;
        log('✅ All assets ready for target');
        if (this._wantStartOnReady) this._startAll(); // si la cible est déjà détectée, on démarre maintenant
      });

      // 5) targetFound / targetLost
      root.addEventListener('targetFound', () => {
        this._isVisible = true;
        if (this._allReady) this._startAll();
        else this._wantStartOnReady = true;
      });

      root.addEventListener('targetLost', () => {
        this._isVisible = false;
        this._wantStartOnReady = false;
        this._stopAll();
      });

      // Tentatives d’autoplay “sans tap” : au démarrage rendu / arReady
      const scene = root.sceneEl;
      const tryResume = () => {
        try {
          const ctx = this._getAudioContext();
          if (ctx && ctx.state === 'suspended') ctx.resume().catch(()=>{});
        } catch {}
      };
      scene.addEventListener('renderstart', tryResume, {once:true});
      scene.addEventListener('arReady', tryResume, {once:true});
    },

    _startAll() {
      // PNG
      if (this.assets.png) {
        this.assets.png.setAttribute('visible', 'true');
        const comp = this.assets.png.components['png-sequence'];
        if (comp) comp.start();
      }
      // 3D
      this.assets.models.forEach(ent => {
        ent.setAttribute('visible', 'true');
        ent.setAttribute('animation-mixer', 'timeScale: 1');  // PLAY
      });
      // AUDIO
      if (this.assets.audio && this._audioTracks?.length) {
        this.assets.audio.setAttribute('visible', 'true');
        this._playCurrentTrack(); // tente l’autoplay
      }
    },

    _stopAll() {
      if (this.assets.png) {
        const comp = this.assets.png.components['png-sequence'];
        if (comp) comp.stop();
        this.assets.png.setAttribute('visible', 'false');
      }
      this.assets.models.forEach(ent => {
        ent.setAttribute('animation-mixer', 'timeScale: 0');  // PAUSE
        ent.setAttribute('visible', 'false');
      });
      if (this.assets.audio) {
        this._stopAudio();
        this.assets.audio.setAttribute('visible', 'false');
      }
    },

    // ————— Modèles 3D —————
    _createModelEntity(url) {
      const ent = document.createElement('a-entity');
      ent.setAttribute('visible', 'false');
      ent.setAttribute('gltf-model', `url(${url})`);
      ent.setAttribute('position', this.data.modelPos);
      ent.setAttribute('rotation', this.data.modelRot);
      ent.setAttribute('scale',    this.data.modelScale);
      ent.setAttribute('animation-mixer', `clip: ${this.data.animClip}; loop: ${this.data.animLoop}; timeScale: 0`);

      ent.addEventListener('model-loaded', () => {
        const mesh = ent.getObject3D('mesh');
        const clips = (mesh && mesh.animations) ? mesh.animations : [];
        if (!clips.length) {
          console.warn('[3D] Aucun clip d’animation trouvé dans', url);
          return;
        }
        ent.setAttribute('animation-mixer', `clip: ${this.data.animClip}; loop: ${this.data.animLoop}; timeScale: 0`);
        if (this._isVisible && this._allReady) {
          ent.setAttribute('animation-mixer', 'timeScale: 1');  // PLAY si déjà visible
        }
      });
      ent.addEventListener('model-error', (err) => {
        console.error('[3D] model-error pour', url, err);
      });
      return ent;
    },

    // ————— Audio : détection + préchargement + lecture —————
    async _discoverAndPreloadAudio() {
      const exts = ['mp3','ogg','wav'];
      const tracks = [];

      // 1) Nom “classique” (audio.ext) si le prefix ne finit pas par _ ou -
      const base = this.data.audioPrefix.replace(/[_-]$/, '');
      for (const ext of exts) {
        const url = `${base}.${ext}`;
        const ok = await headExists(url);
        if (ok) { tracks.push(url); break; }
      }

      // 2) Séquence audio_000.ext…
      if (!tracks.length) {
        const pad = n => n.toString().padStart(this.data.audioPad, '0');
        for (let i = this.data.audioStart; i < this.data.audioMax; i++) {
          let foundThis = false;
          for (const ext of exts) {
            const url = `${this.data.audioPrefix}${pad(i)}.${ext}`;
            // eslint-disable-next-line no-await-in-loop
            const ok = await headExists(url);
            if (ok) { tracks.push(url); foundThis = true; break; }
          }
          if (!foundThis) {
            if (tracks.length > 0) break;
          }
        }
      }

      this._audioTracks = tracks;
      if (!tracks.length) {
        log('[audio] aucune piste trouvée pour', this.data.audioPrefix);
        return;
      }

      // Précharge via éléments <audio> (canplaythrough)
      await Promise.all(tracks.map(url => new Promise(resolve => {
        const a = new Audio();
        a.preload = 'auto';
        a.src = url;
        const done = () => { cleanup(); resolve(); };
        const cleanup = () => { a.removeEventListener('canplaythrough', done); a.removeEventListener('error', done); };
        a.addEventListener('canplaythrough', done, {once:true});
        a.addEventListener('error', done, {once:true});
        // kick
        a.load();
      })));
      log('🔊 Audio preloaded:', tracks);
    },

    _getAudioContext() {
      const scene = this.el.sceneEl;
      if (!scene.audioListener) {
        // A-Frame crée audioListener à la 1ère utilisation du composant sound
        const audioEnt = this.assets.audio;
        if (audioEnt) audioEnt.components.sound?.playSound?.(); // force init
        audioEnt?.components.sound?.stopSound?.();
      }
      return (this.el.sceneEl.audioListener && this.el.sceneEl.audioListener.context) || null;
    },

    _playCurrentTrack() {
      if (!this.assets.audio || !this._audioTracks?.length) return;
      const ctx = this._getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        // tentative d’autoplay sans geste ; si bloqué, le navigateur ignorera
        ctx.resume().catch(()=>{});
      }

      const url = this._audioTracks[this._trackIndex || 0];
      this.assets.audio.setAttribute('sound',
        `src: url(${url}); autoplay: false; loop: false; volume: ${this.data.audioVolume}; positional: ${!this.data.audioNonPos}`
      );
      const snd = this.assets.audio.components.sound;
      if (snd) {
        try { snd.stopSound(); } catch {}
        setTimeout(() => {
          try { snd.playSound(); log('[audio] PLAY →', url); } catch (e) { log('[audio] autoplay blocked'); }
        }, 0);
      }

      // Fin de piste → suivante / loop-all
      const onEnded = () => {
        if (this.data.audioLoop === 'all' && this._audioTracks.length > 1) {
          this._trackIndex = ((this._trackIndex || 0) + 1) % this._audioTracks.length;
          this._playCurrentTrack();
        }
        this.assets.audio.removeEventListener('sound-ended', onEnded);
      };
      this.assets.audio.addEventListener('sound-ended', onEnded);
    },

    _stopAudio() {
      const snd = this.assets.audio?.components.sound;
      if (snd) { try { snd.stopSound(); } catch {} }
      this._trackIndex = 0;
    }
  });
}

/* Utilitaire HEAD (teste existence d’un fichier) */
async function headExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch { return false; }
}