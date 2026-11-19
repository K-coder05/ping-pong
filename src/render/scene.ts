import {
  AmbientLight,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import {
  BALL_DRAW_SCALE,
  BALL_RADIUS,
  FEEDER_MOUTH,
  NET_HEIGHT,
  NET_LENGTH,
  PLAY_CAMERA_FOV,
  PLAY_CAMERA_POSITION,
  PLAY_CAMERA_TARGET,
  TABLE_LENGTH,
  TABLE_THICKNESS,
  TABLE_TOP_Y,
  TABLE_WIDTH,
} from '../game/constants.ts';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface TableScene {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  /** The fixed camera behind the player's end, looking toward the Feeder. */
  readonly playCamera: PerspectiveCamera;
  /**
   * Draw the ball at its physics centre, using the live BALL_DRAW_SCALE, with
   * a dark shadow dropped straight down onto the table (or the floor, off it).
   */
  syncBall(position: Vec3Like): void;
  /**
   * The debug Ideal Time marker: a ring where the Feed will cross the player's
   * end, lit up once it has (`reached`). Null hides it.
   */
  syncIdealTimeMarker(marker: { position: Vec3Like; reached: boolean } | null): void;
  /** Resize the drawing buffer and the play camera to the canvas size. */
  resize(width: number, height: number): void;
  render(camera: PerspectiveCamera): void;
}

const LINE_WIDTH = 0.02; // ITTF edge lines
const CENTRE_LINE_WIDTH = 0.003;
const LINE_LIFT = 0.001; // keeps lines off the table surface to avoid z-fighting
const SHADOW_LIFT = 0.002; // above the lines
const IDEAL_MARKER_WAITING = 0x4fd1ff;
const IDEAL_MARKER_REACHED = 0xfff27a;

export function createTableScene(canvas: HTMLCanvasElement): TableScene {
  // three's WebGLRenderer is WebGL2-only.
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(0x1d2230);

  addLights(scene);
  scene.add(createFloor(), createTable(), createNet(), createFeeder());

  const ball = createBall();
  const shadow = createBallShadow();
  const idealMarker = createIdealTimeMarker();
  scene.add(ball, shadow, idealMarker);

  const playCamera = new PerspectiveCamera(PLAY_CAMERA_FOV, 1, 0.05, 50);
  playCamera.position.set(PLAY_CAMERA_POSITION.x, PLAY_CAMERA_POSITION.y, PLAY_CAMERA_POSITION.z);
  playCamera.lookAt(PLAY_CAMERA_TARGET.x, PLAY_CAMERA_TARGET.y, PLAY_CAMERA_TARGET.z);

  return {
    renderer,
    scene,
    playCamera,
    syncBall(position) {
      const scale = BALL_DRAW_SCALE.value;
      ball.scale.setScalar(scale);
      // Lift the enlarged ball so its bottom sits where the physics ball's
      // bottom is: it then visibly touches the table at each bounce.
      ball.position.set(position.x, position.y + BALL_RADIUS * (scale - 1), position.z);

      // Straight down, the same size as the drawn ball: where it lands is
      // where the shadow meets it, the main cue for judging when it arrives.
      const overTable = Math.abs(position.x) <= TABLE_WIDTH / 2 && Math.abs(position.z) <= TABLE_LENGTH / 2;
      const groundY = overTable && position.y >= TABLE_TOP_Y ? TABLE_TOP_Y : 0;
      shadow.scale.setScalar(scale);
      shadow.position.set(position.x, groundY + SHADOW_LIFT, position.z);
    },
    syncIdealTimeMarker(marker) {
      idealMarker.visible = marker !== null;
      if (!marker) return;
      idealMarker.position.set(marker.position.x, marker.position.y, marker.position.z);
      idealMarker.material.color.setHex(marker.reached ? IDEAL_MARKER_REACHED : IDEAL_MARKER_WAITING);
      idealMarker.material.opacity = marker.reached ? 0.95 : 0.6;
    },
    resize(width, height) {
      renderer.setSize(width, height);
      playCamera.aspect = width / height;
      playCamera.updateProjectionMatrix();
    },
    render(camera) {
      renderer.render(scene, camera);
    },
  };
}

function addLights(scene: Scene): void {
  scene.add(new HemisphereLight(0xdde6ff, 0x30302a, 0.9));
  scene.add(new AmbientLight(0xffffff, 0.25));
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(1.5, 4, 2.5);
  scene.add(key);
}

function createFloor(): Mesh {
  const floor = new Mesh(new PlaneGeometry(30, 30), new MeshStandardMaterial({ color: 0x3a3f4b, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  return floor;
}

function createTable(): Group {
  const table = new Group();
  const surface = new MeshStandardMaterial({ color: 0x1f4f8f, roughness: 0.6 });
  const white = new MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5 });
  const legMaterial = new MeshStandardMaterial({ color: 0x22252b, roughness: 0.8 });

  const top = new Mesh(new BoxGeometry(TABLE_WIDTH, TABLE_THICKNESS, TABLE_LENGTH), surface);
  top.position.y = TABLE_TOP_Y - TABLE_THICKNESS / 2;
  table.add(top);

  const lineY = TABLE_TOP_Y + LINE_LIFT;
  const line = (width: number, length: number, x: number, z: number) => {
    const mesh = new Mesh(new PlaneGeometry(width, length), white);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, lineY, z);
    table.add(mesh);
  };
  // Side lines run along z; end lines along x; the centre line splits the halves for doubles.
  line(LINE_WIDTH, TABLE_LENGTH, -(TABLE_WIDTH - LINE_WIDTH) / 2, 0);
  line(LINE_WIDTH, TABLE_LENGTH, (TABLE_WIDTH - LINE_WIDTH) / 2, 0);
  line(TABLE_WIDTH, LINE_WIDTH, 0, -(TABLE_LENGTH - LINE_WIDTH) / 2);
  line(TABLE_WIDTH, LINE_WIDTH, 0, (TABLE_LENGTH - LINE_WIDTH) / 2);
  line(CENTRE_LINE_WIDTH, TABLE_LENGTH, 0, 0);

  const legHeight = TABLE_TOP_Y - TABLE_THICKNESS;
  const legGeometry = new BoxGeometry(0.05, legHeight, 0.05);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      const leg = new Mesh(legGeometry, legMaterial);
      leg.position.set(x * (TABLE_WIDTH / 2 - 0.15), legHeight / 2, z * (TABLE_LENGTH / 2 - 0.3));
      table.add(leg);
    }
  }
  return table;
}

function createNet(): Group {
  const net = new Group();
  const mesh = new Mesh(
    new BoxGeometry(NET_LENGTH, NET_HEIGHT, 0.004),
    new MeshStandardMaterial({ color: 0x111418, transparent: true, opacity: 0.75, roughness: 1 }),
  );
  mesh.position.set(0, TABLE_TOP_Y + NET_HEIGHT / 2, 0);
  net.add(mesh);

  const tape = new Mesh(new BoxGeometry(NET_LENGTH, 0.015, 0.006), new MeshStandardMaterial({ color: 0xf4f4f4 }));
  tape.position.set(0, TABLE_TOP_Y + NET_HEIGHT - 0.0075, 0);
  net.add(tape);

  const postGeometry = new BoxGeometry(0.02, NET_HEIGHT + 0.02, 0.04);
  const postMaterial = new MeshStandardMaterial({ color: 0x22252b });
  for (const side of [-1, 1]) {
    const post = new Mesh(postGeometry, postMaterial);
    post.position.set(side * (NET_LENGTH / 2), TABLE_TOP_Y + (NET_HEIGHT + 0.02) / 2, 0);
    net.add(post);
  }
  return net;
}

function createBall(): Mesh {
  return new Mesh(
    new SphereGeometry(BALL_RADIUS, 32, 16),
    new MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.4, emissive: 0x331500 }),
  );
}

/** A dark disc the size of the physics ball (scaled with it), lying flat. */
function createBallShadow(): Mesh {
  const shadow = new Mesh(
    new CircleGeometry(BALL_RADIUS, 24),
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  return shadow;
}

/** A ring standing across the player's end line, facing the play camera. */
function createIdealTimeMarker(): Mesh<RingGeometry, MeshBasicMaterial> {
  const marker = new Mesh(
    new RingGeometry(BALL_RADIUS * 2.5, BALL_RADIUS * 3.2, 32),
    new MeshBasicMaterial({ color: IDEAL_MARKER_WAITING, transparent: true, opacity: 0.6, side: DoubleSide, depthWrite: false }),
  );
  marker.visible = false;
  return marker;
}

/**
 * The Feeder: a plain box on a post behind the far end, with a short barrel
 * whose mouth is FEEDER_MOUTH, where each Feed leaves from.
 */
function createFeeder(): Group {
  const feeder = new Group();
  const bodyMaterial = new MeshStandardMaterial({ color: 0x3b4252, roughness: 0.7 });
  const accent = new MeshStandardMaterial({ color: 0xe5e9f0, roughness: 0.5 });

  const barrelLength = 0.1;
  const barrel = new Mesh(new CylinderGeometry(0.035, 0.035, barrelLength, 20), accent);
  barrel.rotation.x = Math.PI / 2; // along z, toward the player
  barrel.position.set(FEEDER_MOUTH.x, FEEDER_MOUTH.y, FEEDER_MOUTH.z - barrelLength / 2);
  feeder.add(barrel);

  const bodyDepth = 0.22;
  const body = new Mesh(new BoxGeometry(0.32, 0.24, bodyDepth), bodyMaterial);
  const bodyZ = FEEDER_MOUTH.z - barrelLength - bodyDepth / 2;
  body.position.set(FEEDER_MOUTH.x, FEEDER_MOUTH.y, bodyZ);
  feeder.add(body);

  // The post holds the body up from the floor, clear of the table's far end.
  const postHeight = FEEDER_MOUTH.y - 0.12;
  const post = new Mesh(new BoxGeometry(0.05, postHeight, 0.05), bodyMaterial);
  post.position.set(FEEDER_MOUTH.x, postHeight / 2, bodyZ);
  feeder.add(post);
  return feeder;
}
