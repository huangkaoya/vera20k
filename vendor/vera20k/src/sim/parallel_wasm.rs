//! Browser execution uses one deterministic worker, retaining item order.
pub(crate) fn map<T: Sync, R: Send>(items: &[T], work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    items.iter().map(work).collect()
}
pub(crate) fn map_in_order<T: Sync, B, R: Send>(
    items: &[T],
    before: impl Fn() -> B + Sync,
    work: impl Fn(&T, B) -> R + Sync,
) -> Vec<R> {
    items.iter().map(|item| work(item, before())).collect()
}
pub(crate) fn map_with<T: Sync, S: Clone + Send, R: Send>(
    items: &[T],
    mut init: S,
    work: impl Fn(&mut S, &T) -> R + Sync,
) -> Vec<R> {
    items.iter().map(|item| work(&mut init, item)).collect()
}
pub(crate) fn select_indices(len: usize, keep: impl Fn(usize) -> bool + Sync) -> Vec<usize> {
    (0..len).filter(|&i| keep(i)).collect()
}
pub(crate) fn filter_map_indices<R: Send>(
    len: usize,
    pick: impl Fn(usize) -> Option<R> + Sync,
) -> Vec<R> {
    (0..len).filter_map(pick).collect()
}
pub(crate) fn for_each_mut<T: Send>(items: &mut [T], work: impl Fn(&mut T) + Sync) {
    items.iter_mut().for_each(work);
}
pub(crate) fn any_index(len: usize, test: impl Fn(usize) -> bool + Sync) -> bool {
    (0..len).any(test)
}
pub(crate) fn alongside(pooled: impl FnOnce() + Send, here: impl FnOnce()) {
    pooled();
    here();
}
