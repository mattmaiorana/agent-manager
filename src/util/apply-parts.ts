// A big class written in several files: each part is a plain class holding some of its
// methods, and applyParts copies them onto the base class's prototype, as non-enumerable
// properties, exactly as class methods are. It runs where the base class is declared, when
// that file is first evaluated, so every method is in place before Obsidian loads the
// plugin or opens a view. A name the base already has is an error, so a method can't land
// twice. Constructors, methods that use `super`, and methods that name their own class stay
// in the base class.
// The types see the parts through an interface declared beside the base class, which
// extends it and every part (`interface AgentManagerPlugin extends VaultTerminalPlugin,
// ConfigMethods, ...`, plugin/main.ts).
interface ClassLike {
  readonly name: string;
  readonly prototype: object;
}
function applyParts(Base: ClassLike, ...parts: ClassLike[]): void {
  for (const Part of parts) {
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(Part.prototype);
    // `delete descriptors.constructor`, which TypeScript reads as Object's constructor.
    Reflect.deleteProperty(descriptors, "constructor");
    for (const name of Reflect.ownKeys(descriptors)) {
      if (Object.prototype.hasOwnProperty.call(Base.prototype, name)) {
        throw new Error(`${Base.name}: ${String(name)} is defined twice (in ${Part.name} too)`);
      }
    }
    Object.defineProperties(Base.prototype, descriptors);
  }
}
export { applyParts };
