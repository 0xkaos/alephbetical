import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const CHAR_MAP = {
    'א': 'Aleph',
    'ב': 'Bet',
    'ג': 'Gimmel',
    'ד': 'Dalet',
    'ה': 'Hei',
    'ו': 'Vav',
    'ז': 'Zayin',
    'ח': 'Het',
    'ט': 'Tet',
    'י': 'Yud',
    'כ': 'Kaf',
    'ך': 'Final Kaf',
    'ל': 'Lamed',
    'מ': 'Mem',
    'ם': 'Final Mem',
    'נ': 'Nun',
    'ן': 'Final Nun',
    'ס': 'Samech',
    'ע': 'Ayin',
    'פ': 'Pei',
    'ף': 'Final Pei',
    'צ': 'Tzadi',
    'ץ': 'Final Tzadi',
    'ק': 'Kuf',
    'ר': 'Resh',
    'ש': 'Shin',
    'ת': 'Tav'
};

const CURVE_SEGMENTS = 96;
const BASE_SPACING = 100;
const DRAW_SPEED = 0.24;
const LINE_ADVANCE = 155;

class ScriptFontWriter {
    constructor() {
        this.letterData = null;
        this.dataError = null;
        this.dataPromise = this.loadData().catch(error => {
            this.dataError = error;
            return null;
        });
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.stage = null;
        this.textGroup = null;
        this.rawBounds = null;
        this.animationQueue = [];
        this.animationFrame = null;
        this.animationStart = 0;
        this.isAnimating = false;
        this.scale = 1;
        this.settings = { size: 100, stroke: 7, speed: 1.5 };
        this.writeGeneration = 0;
        this.resizeFrame = null;
        this.materials = new Set();
        this.resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => this.scheduleResize())
            : null;

        if (!this.resizeObserver) {
            window.addEventListener('resize', () => this.scheduleResize());
        }
    }

    async loadData() {
        const response = await fetch('./letters.json');
        if (!response.ok) {
            throw new Error(`Unable to load letters.json (${response.status})`);
        }

        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('letters.json does not contain a glyph map');
        }

        this.letterData = data;
        return data;
    }

    async write(stage, text, settings = {}, { animate = true } = {}) {
        const generation = ++this.writeGeneration;
        this.settings = {
            size: Number(settings.size) || 100,
            stroke: Number(settings.stroke) || 7,
            speed: Number(settings.speed) || 1.5
        };

        try {
            await this.dataPromise;
            if (generation !== this.writeGeneration || !stage.isConnected) return;
            if (!this.letterData) throw this.dataError || new Error('Stroke data is unavailable');

            this.mount(stage);
            this.buildText(this.normalizeText(text));
            this.resize(animate);
        } catch (error) {
            console.error('Animated script font:', error);
            if (generation === this.writeGeneration && stage.isConnected) {
                this.showFallback(stage, text);
            }
        }
    }

    replay() {
        if (!this.textGroup || !this.animationQueue.length) return;
        this.configureAnimation(true);
    }

    unmount() {
        this.writeGeneration += 1;
        this.stopAnimation();
        this.resizeObserver?.disconnect();
        this.stage = null;
        this.clearText();
    }

    mount(stage) {
        this.ensureRenderer();
        if (this.stage !== stage) {
            this.resizeObserver?.disconnect();
            this.stage = stage;
            this.resizeObserver?.observe(stage);
        }
        if (this.renderer.domElement.parentElement !== stage) {
            stage.replaceChildren(this.renderer.domElement);
        }
    }

    ensureRenderer() {
        if (this.renderer) return;

        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
        this.camera.position.z = 1;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.domElement.setAttribute('aria-hidden', 'true');
    }

    normalizeText(text) {
        return String(text || '').replace(/[\u0591-\u05C7]/g, '').trim();
    }

    getLetterMeta(char) {
        if (char === ' ') {
            return { strokes: null, width: 0.65, startX: 0 };
        }

        const name = CHAR_MAP[char];
        const data = name ? this.letterData?.[name] : null;
        if (!data) {
            return { strokes: null, width: 0.45, startX: 0 };
        }
        if (Array.isArray(data)) {
            return { strokes: data, width: 1, startX: 0 };
        }

        return {
            strokes: data.strokes,
            width: data.width ?? 1,
            startX: data.startX ?? 0
        };
    }

    buildText(text) {
        this.stopAnimation();
        this.clearText();
        this.animationQueue = [];

        if (!text) return;

        const bounds = {
            minX: Infinity,
            maxX: -Infinity,
            minY: Infinity,
            maxY: -Infinity
        };
        const group = new THREE.Group();
        const lines = this.chooseLines(text);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const lineText = lines[lineIndex];
            const lineY = ((lines.length - 1) / 2 - lineIndex) * LINE_ADVANCE;
            let cursorX = this.measureText(lineText) / 2;

            for (const char of lineText) {
                const { strokes, width, startX } = this.getLetterMeta(char);
                const letterX = cursorX - startX * BASE_SPACING;

                if (strokes) {
                    const letterGroup = new THREE.Group();
                    letterGroup.position.set(letterX, lineY, 0);
                    const animationItem = { strokes: [], startTime: 0, duration: 0 };

                    for (const strokePoints of strokes) {
                        if (!Array.isArray(strokePoints) || strokePoints.length < 2) continue;

                        const vectors = strokePoints.map(point => new THREE.Vector3(point[0], point[1], 0));
                        const curve = new THREE.CatmullRomCurve3(vectors, false, 'centripetal', 0.5);
                        const curvePoints = curve.getSpacedPoints(CURVE_SEGMENTS);
                        const positions = [];

                        for (const point of curvePoints) {
                            positions.push(point.x, point.y, point.z);
                            bounds.minX = Math.min(bounds.minX, point.x + letterX);
                            bounds.maxX = Math.max(bounds.maxX, point.x + letterX);
                            bounds.minY = Math.min(bounds.minY, point.y + lineY);
                            bounds.maxY = Math.max(bounds.maxY, point.y + lineY);
                        }

                        const geometry = new LineGeometry();
                        geometry.setPositions(positions);
                        geometry.instanceCount = 0;

                        const material = new LineMaterial({
                            color: 0xffffff,
                            linewidth: this.settings.stroke,
                            worldUnits: false,
                            alphaToCoverage: true,
                            resolution: new THREE.Vector2(1, 1)
                        });
                        const line = new Line2(geometry, material);
                        line.computeLineDistances();
                        line.userData.totalSegments = CURVE_SEGMENTS;
                        letterGroup.add(line);
                        this.materials.add(material);

                        animationItem.strokes.push({
                            line,
                            rawLength: curve.getLength(),
                            length: 0
                        });
                    }

                    if (animationItem.strokes.length) {
                        this.animationQueue.push(animationItem);
                        group.add(letterGroup);
                    }
                }

                cursorX -= width * BASE_SPACING;
            }
        }

        if (!group.children.length || !Number.isFinite(bounds.minX)) {
            this.showFallback(this.stage, text);
            return;
        }

        this.textGroup = group;
        this.rawBounds = bounds;
        this.scene.add(group);
    }

    measureText(text) {
        let width = 0;
        for (const char of text) {
            width += this.getLetterMeta(char).width * BASE_SPACING;
        }
        return width;
    }

    chooseLines(text) {
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length < 2 || !this.stage) return [text];

        const availableWidth = Math.max(40, this.stage.clientWidth - 72);
        const availableHeight = Math.max(40, this.stage.clientHeight - 56);
        const maxLines = Math.min(4, words.length);
        let best = { lines: [text], scale: 0 };

        for (let lineCount = 1; lineCount <= maxLines; lineCount += 1) {
            const lines = this.partitionWords(words, lineCount);
            const widestLine = Math.max(...lines.map(line => this.measureText(line)));
            const estimatedHeight = 140 + (lines.length - 1) * LINE_ADVANCE;
            const scale = Math.min(availableWidth / widestLine, availableHeight / estimatedHeight);

            if (scale > best.scale) {
                best = { lines, scale };
            }
        }

        return best.lines;
    }

    partitionWords(words, lineCount) {
        if (lineCount === 1) return [words.join(' ')];

        const count = words.length;
        const wordWidths = words.map(word => this.measureText(word));
        const spaceWidth = this.measureText(' ');
        const prefix = [0];
        wordWidths.forEach(width => prefix.push(prefix[prefix.length - 1] + width));
        const lineWidth = (start, end) => prefix[end] - prefix[start] + Math.max(0, end - start - 1) * spaceWidth;
        const scores = Array.from({ length: lineCount + 1 }, () => Array(count + 1).fill(Infinity));
        const breaks = Array.from({ length: lineCount + 1 }, () => Array(count + 1).fill(-1));
        scores[0][0] = 0;

        for (let lines = 1; lines <= lineCount; lines += 1) {
            for (let end = lines; end <= count; end += 1) {
                for (let start = lines - 1; start < end; start += 1) {
                    const score = Math.max(scores[lines - 1][start], lineWidth(start, end));
                    if (score < scores[lines][end]) {
                        scores[lines][end] = score;
                        breaks[lines][end] = start;
                    }
                }
            }
        }

        const result = [];
        let end = count;
        for (let lines = lineCount; lines > 0; lines -= 1) {
            const start = breaks[lines][end];
            result.unshift(words.slice(start, end).join(' '));
            end = start;
        }
        return result;
    }

    resize(animate = this.isAnimating) {
        if (!this.stage || !this.renderer || !this.camera) return;

        const width = Math.round(this.stage.clientWidth);
        const height = Math.round(this.stage.clientHeight);
        if (width < 2 || height < 2) return;

        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(width, height, false);
        this.camera.left = -width / 2;
        this.camera.right = width / 2;
        this.camera.top = height / 2;
        this.camera.bottom = -height / 2;
        this.camera.updateProjectionMatrix();
        this.materials.forEach(material => material.resolution.set(width, height));

        if (this.textGroup && this.rawBounds) {
            const rawWidth = Math.max(1, this.rawBounds.maxX - this.rawBounds.minX);
            const rawHeight = Math.max(1, this.rawBounds.maxY - this.rawBounds.minY);
            const availableWidth = Math.max(40, width - 72);
            const availableHeight = Math.max(40, height - 56);
            const fitScale = Math.min(availableWidth / rawWidth, availableHeight / rawHeight, 1.6);
            this.scale = fitScale * (this.settings.size / 100);

            const centerX = (this.rawBounds.minX + this.rawBounds.maxX) / 2;
            const centerY = (this.rawBounds.minY + this.rawBounds.maxY) / 2;
            this.textGroup.scale.setScalar(this.scale);
            this.textGroup.position.set(-centerX * this.scale, -centerY * this.scale, 0);
            this.configureAnimation(animate);
        } else {
            this.render();
        }
    }

    scheduleResize() {
        cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = requestAnimationFrame(() => this.resize(this.isAnimating));
    }

    configureAnimation(animate) {
        this.stopAnimation();
        let startTime = 0;

        for (const item of this.animationQueue) {
            let itemLength = 0;
            for (const stroke of item.strokes) {
                stroke.length = stroke.rawLength * this.scale;
                itemLength += stroke.length;
                stroke.line.geometry.instanceCount = animate ? 0 : stroke.line.userData.totalSegments;
            }
            item.startTime = startTime;
            item.duration = itemLength / (DRAW_SPEED * this.settings.speed);
            startTime += item.duration;
        }

        if (animate && this.animationQueue.length) {
            this.isAnimating = true;
            this.animationStart = performance.now();
            this.animationFrame = requestAnimationFrame(time => this.animate(time));
        } else {
            this.render();
        }
    }

    animate(now) {
        if (!this.isAnimating) return;

        const elapsed = now - this.animationStart;
        let animationComplete = true;

        for (const item of this.animationQueue) {
            const itemElapsed = elapsed - item.startTime;
            if (itemElapsed < 0) {
                animationComplete = false;
                item.strokes.forEach(stroke => {
                    stroke.line.geometry.instanceCount = 0;
                });
                continue;
            }

            if (itemElapsed >= item.duration) {
                item.strokes.forEach(stroke => {
                    stroke.line.geometry.instanceCount = stroke.line.userData.totalSegments;
                });
                continue;
            }

            animationComplete = false;
            let distance = itemElapsed * DRAW_SPEED * this.settings.speed;
            for (const stroke of item.strokes) {
                if (distance >= stroke.length) {
                    stroke.line.geometry.instanceCount = stroke.line.userData.totalSegments;
                    distance -= stroke.length;
                } else if (distance > 0) {
                    const progress = distance / stroke.length;
                    stroke.line.geometry.instanceCount = Math.max(1, Math.floor(progress * stroke.line.userData.totalSegments));
                    distance = 0;
                } else {
                    stroke.line.geometry.instanceCount = 0;
                }
            }
        }

        this.render();
        if (animationComplete) {
            this.isAnimating = false;
            this.animationFrame = null;
        } else {
            this.animationFrame = requestAnimationFrame(time => this.animate(time));
        }
    }

    render() {
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    stopAnimation() {
        if (this.animationFrame !== null) {
            cancelAnimationFrame(this.animationFrame);
        }
        this.animationFrame = null;
        this.isAnimating = false;
    }

    clearText() {
        if (!this.textGroup || !this.scene) return;

        this.textGroup.traverse(child => {
            if (child.isLine2) {
                this.materials.delete(child.material);
                child.geometry.dispose();
                child.material.dispose();
            }
        });
        this.scene.remove(this.textGroup);
        this.textGroup = null;
        this.rawBounds = null;
        this.animationQueue = [];
    }

    showFallback(stage, text) {
        if (!stage) return;
        const fallback = document.createElement('div');
        fallback.className = 'script-font-fallback';
        fallback.textContent = text;
        stage.replaceChildren(fallback);
    }
}

window.scriptFontWriter = new ScriptFontWriter();
window.dispatchEvent(new Event('script-font-ready'));
