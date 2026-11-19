import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import {
  BALL_DRAW_SCALE,
  BALL_RADIUS,
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
  /** Draw the ball at its physics centre, using the live BALL_DRAW_SCALE. */
  syncBall(position: Vec3Like): void;
  /** Resize the drawing buffer and the play camera to the canvas size. */
  resize(width: number, height: number): void;
  render(camera: PerspectiveCamera): void;
}

const LINE_WIDTH = 0.02; // ITTF edge lines
const CENTRE_LINE_WIDTH = 0.003;
const LINE_LIFT = 0.001; // keeps lines off the table surface to avoid z-fighting

export function createTableScene(canvas: HTMLCanvasElement): TableScene {
  // three's WebGLRenderer is WebGL2-only.
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(0x1d2230);

  addLights(scene);
  scene.add(createFloor(), createTable(), createNet());

  const ball = createBall();
  scene.add(ball);

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
