// A big class written in several files: each part is a plain class holding some of its
// methods, and applyParts copies them onto the base class's prototype, as non-enumerable
// properties, exactly as class methods are. It runs where the base class is declared, when
// that file is first evaluated, so every method is in place before Obsidian loads the
// plugin or opens a view. A name the base already has is an error, so a method can't land
// twice. Constructors, methods that use `super`, and methods that name their own class stay
// in the base class.
function applyParts(Base, ...parts) {
  for (const Part of parts) {
    const descriptors = Object.getOwnPropertyDescriptors(Part.prototype);
    delete descriptors.constructor;
    for (const name of Reflect.ownKeys(descriptors)) {
      if (Object.prototype.hasOwnProperty.call(Base.prototype, name)) {
        throw new Error(`${Base.name}: ${String(name)} is defined twice (in ${Part.name} too)`);
      }
    }
    Object.defineProperties(Base.prototype, descriptors);
  }
}
export { applyParts };
