//! The binary heap of gamemd's two path searches: the cell A*'s open list
//! (`PathfinderClass+0x14`, inline insert `0x0042A061..0x0042A122` and pop
//! `0x0042A2BB..0x0042A3B1`) and `Zone_precheck`'s (`PathfinderClass+0x68`,
//! inline inserts `0x0042C401..0x0042C477` and `0x0042C693..0x0042C6F5`, pop
//! through `MinHeap__SiftDown @ 0x0042DCA0` from `0x0042C4C0`).
//!
//! Both compare strictly: an insert climbs only past a parent that costs
//! more, and a sift moves down only to a child that costs less, the left one
//! first, so equal costs keep their array order. A `BinaryHeap` with a tie-break
//! does not reproduce that order. The caller supplies the cost comparison.

/// A 0-based array heap; native index `i` (1-based) is index `i - 1` here.
/// `SIZE` is the heap's native size word (`+0x04`): an insert that would
/// bring the count to it is dropped (`count + 1 >= size`, the A*'s
/// `0x0042A071`/`0x0042A0D9` and the precheck's `0x0042C40F`/`0x0042C6A0`).
#[derive(Debug)]
pub(super) struct NativeHeap<T, const SIZE: usize>(Vec<T>);

impl<T, const SIZE: usize> Default for NativeHeap<T, SIZE> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<T: Copy, const SIZE: usize> NativeHeap<T, SIZE> {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    /// The root, which the next pop returns.
    pub(super) fn first(&self) -> Option<&T> {
        self.0.first()
    }

    /// Insert `item`, climbing past each parent that `less` puts after it,
    /// unless the heap is full.
    pub(super) fn push(&mut self, item: T, less: impl Fn(&T, &T) -> bool) {
        if self.0.len() + 1 >= SIZE {
            return;
        }
        let mut position = self.0.len();
        self.0.push(item);
        while position != 0 {
            let parent = (position - 1) / 2;
            if !less(&item, &self.0[parent]) {
                break;
            }
            self.0[position] = self.0[parent];
            position = parent;
        }
        self.0[position] = item;
    }

    /// Remove the root, moving the last item to the root and sifting it down.
    pub(super) fn pop(&mut self, less: impl Fn(&T, &T) -> bool) -> Option<T> {
        let first = *self.0.first()?;
        let last = self.0.pop().expect("nonempty heap");
        if !self.0.is_empty() {
            self.0[0] = last;
            self.sift_down(&less);
        }
        Some(first)
    }

    /// Put `item` at the root and sift it down, returning the old root. The
    /// A* takes its next node this way when the held child costs no less
    /// than the root (`0x0042A1E8`).
    pub(super) fn replace_first(&mut self, item: T, less: impl Fn(&T, &T) -> bool) -> T {
        let first = std::mem::replace(&mut self.0[0], item);
        self.sift_down(&less);
        first
    }

    /// Sift the root down: at each level the item moves to the cheaper child
    /// if that child costs less than it, the left one when they tie. The
    /// item is held aside and written once where it stops.
    ///
    /// Native tests the left child against the item, then the right against
    /// the cheaper of the two. Choosing the cheaper child first (the right
    /// only when it costs strictly less) and testing it against the item
    /// moves to the same child: the chosen child costs no more than the
    /// other, so it costs less than the item whenever native moves.
    fn sift_down(&mut self, less: &impl Fn(&T, &T) -> bool) {
        let Some(&item) = self.0.first() else {
            return;
        };
        let len = self.0.len();
        let mut position = 0;
        loop {
            let left = position * 2 + 1;
            if left >= len {
                break;
            }
            let right = left + 1;
            let child = if right < len && less(&self.0[right], &self.0[left]) {
                right
            } else {
                left
            };
            if !less(&self.0[child], &item) {
                break;
            }
            self.0[position] = self.0[child];
            position = child;
        }
        self.0[position] = item;
    }
}

#[cfg(test)]
mod tests {
    use super::NativeHeap;

    /// (cost, arrival) pairs compared by cost alone.
    fn less(a: &(u32, u32), b: &(u32, u32)) -> bool {
        a.0 < b.0
    }

    #[test]
    fn equal_costs_keep_the_native_array_order() {
        let mut heap = NativeHeap::<_, { usize::MAX }>::default();
        for (arrival, cost) in [5, 3, 3, 7, 3, 1, 3].into_iter().enumerate() {
            heap.push((cost, arrival as u32), less);
        }
        let mut order = Vec::new();
        while let Some(item) = heap.pop(less) {
            order.push(item);
        }
        // Not the arrival order among the threes, nor any tie-break: the
        // strict climbs and sifts leave them as the array has them.
        assert_eq!(
            order,
            [(1, 5), (3, 6), (3, 2), (3, 4), (3, 1), (5, 0), (7, 3)]
        );
    }

    #[test]
    fn replace_first_returns_the_root_and_sifts_the_new_item() {
        let mut heap = NativeHeap::<_, { usize::MAX }>::default();
        for (arrival, cost) in [2, 4, 4, 6].into_iter().enumerate() {
            heap.push((cost, arrival as u32), less);
        }
        assert_eq!(heap.replace_first((4, 9), less), (2, 0));
        // The new root ties with its left child and stays put.
        assert_eq!(heap.first(), Some(&(4, 9)));
        assert_eq!(heap.replace_first((5, 8), less), (4, 9));
        assert_eq!(heap.first(), Some(&(4, 1)));
    }

    #[test]
    fn a_full_heap_drops_the_insert() {
        // Size 3 holds two items: the third insert would bring the count to
        // the size, even though it is the cheapest.
        let mut heap = NativeHeap::<_, 3>::default();
        for (arrival, cost) in [2, 4, 1].into_iter().enumerate() {
            heap.push((cost, arrival as u32), less);
        }
        assert_eq!(heap.pop(less), Some((2, 0)));
        assert_eq!(heap.pop(less), Some((4, 1)));
        assert_eq!(heap.pop(less), None);
    }
}
