const join = (...parts) => parts.join('/').replace(/\/+/g, '/');
const dirname = value => value.slice(0, value.lastIndexOf('/')) || '/';
export default { join, dirname };
