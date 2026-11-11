interface ClassLike {
  readonly name: string;
  readonly prototype: object;
}
function applyParts(Base: ClassLike, ...parts: ClassLike[]): void {
  for (const Part of parts) {
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(Part.prototype);
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
