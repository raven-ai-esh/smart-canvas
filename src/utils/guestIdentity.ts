export const animalNames = [
  'Aardvark', 'Albatross', 'Alligator', 'Alpaca', 'Antelope', 'Armadillo', 'Axolotl', 'Badger', 'Bat', 'Beaver',
  'Bison', 'Boar', 'Capybara', 'Caracal', 'Cassowary', 'Cheetah', 'Chinchilla', 'Cobra', 'Coyote', 'Crab',
  'Crane', 'Crocodile', 'Crow', 'Deer', 'Dingo', 'Dolphin', 'Duck', 'Eagle', 'Echidna', 'Egret',
  'Elephant', 'Elk', 'Falcon', 'Fennec', 'Ferret', 'Flamingo', 'Fox', 'Frog', 'Gazelle', 'Gibbon',
  'Giraffe', 'Goose', 'Gorilla', 'Heron', 'Hedgehog', 'Hippo', 'Hornbill', 'Hyena', 'Ibis', 'Iguana',
  'Jaguar', 'Kangaroo', 'Koala', 'Kudu', 'Lemur', 'Leopard', 'Llama', 'Lobster', 'Lynx', 'Manatee',
  'Mantis', 'Meerkat', 'Moose', 'Narwhal', 'Ocelot', 'Octopus', 'Orca', 'Oryx', 'Otter', 'Panda',
  'Panther', 'Parrot', 'Pelican', 'Penguin', 'Piranha', 'Porcupine', 'Quokka', 'Raccoon', 'Raven', 'Rhino',
  'Salamander', 'Seal', 'Serval', 'Sloth', 'Sparrow', 'Swan', 'Tapir', 'Tiger', 'Toucan', 'Turtle',
  'Walrus', 'Warthog', 'Weasel', 'Whale', 'Wolf', 'Wolverine', 'Wombat', 'Yak', 'Zebra', 'Zebu',
];

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getGuestIdentity(seed: string, fallbackName: string) {
  const key = seed || fallbackName || 'Guest';
  const index = hashString(key) % animalNames.length;
  return { index, name: animalNames[index] };
}
