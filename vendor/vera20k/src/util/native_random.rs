//! The native random generator's state words and raw draw: a 250-word table
//! seeded by a four-round hash, drawn by XOR-ing the word at the lead cursor
//! with the word 0x67 slots ahead. `g_MapGenRng @ 0x00ABE890` (random-map
//! generation) and the scenario stream are the same machine; the generated
//! map hands its cursor on to the live scenario
//! (`rng_continuation::MapGenRngContinuation`).
//!
//! Only the state and the raw draw live here. Range reduction stays with each
//! user: `sim::rng::SimRng`'s `RandomRanged` family and
//! `map::rmg::RmgRng`'s chop-53 `uniform`.
//!
//! Native goldens: `tools/rmg_oracle/vectors/rng.json` (seeded state and raw
//! draws, `map::rmg::rng` tests) and the `sim::rng` seed and draw fixtures.

/// Number of state words.
pub(crate) const STATE_WORDS: usize = 250;
/// Distance between the two cursors; also the second cursor's start.
pub(crate) const LAG: usize = 0x67;

/// Seed-hash table mixed into each round's input.
const SEED_TABLE_1: [u32; 4] = [0xBAA9_6887, 0x1E17_D32C, 0x03BC_DC3C, 0x0F33_D1B2];
/// Seed-hash table XOR-ed into each round's rotated square sum. The original
/// table starts with one more word (`0x48AA_D7E4`) that its pre-incremented
/// index never reads.
const SEED_TABLE_2: [u32; 4] = [0x4B0F_3B58, 0xE874_F0C3, 0x6955_C5A6, 0x55A7_CA46];

/// The state words for `seed`. Word `i` starts from `i` and takes four hash
/// rounds; each round folds in the previous round's input, the first the
/// seed.
pub(crate) fn seeded_words(seed: u32) -> [u32; STATE_WORDS] {
    let mut words = [0; STATE_WORDS];
    for (index, word) in words.iter_mut().enumerate() {
        let mut previous = seed;
        let mut mixed = index as u32;
        for round in 0..SEED_TABLE_1.len() {
            let input = SEED_TABLE_1[round] ^ mixed;
            // Signed high half: the original shifts arithmetically.
            let high = (input as i32) >> 16;
            let low = input & 0xFFFF;
            let square_mix =
                (!high.wrapping_mul(high)).wrapping_add((low as i32).wrapping_mul(low as i32));
            let rotated = ((square_mix >> 16) as u32) | ((square_mix as u32) << 16);
            let cross = (high as u32).wrapping_mul(low);
            let next = (rotated ^ SEED_TABLE_2[round]).wrapping_add(cross) ^ previous;
            previous = mixed;
            mixed = next;
        }
        *word = mixed;
    }
    words
}

/// One raw draw: XOR the lagged pair into the word at `lead`, return it, then
/// advance both cursors with wraparound.
#[inline]
pub(crate) fn draw(words: &mut [u32], lead: &mut usize, lagged: &mut usize) -> u32 {
    let value = words[*lead] ^ words[*lagged];
    words[*lead] = value;
    *lead += 1;
    if *lead >= STATE_WORDS {
        *lead = 0;
    }
    *lagged += 1;
    if *lagged >= STATE_WORDS {
        *lagged = 0;
    }
    value
}
