declare module "clipper-lib" {
  type Point = { X: number; Y: number };
  const library: {
    Clipper: { Area(path: Point[]): number };
    JoinType: { jtRound: number };
    EndType: { etClosedPolygon: number };
    ClipperOffset: new () => {
      AddPath(path: Point[], join: number, end: number): void;
      Execute(output: Point[][], distance: number): void;
    };
  };
  export default library;
}
