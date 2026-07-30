/**
 * Intrusive doubly-linked list node for O(1) idle-pool splice.
 * Nodes are pooled; never allocated on the dispatch hot path.
 */
export interface DLLNode<T> {
    value: T;
    prev: DLLNode<T> | null;
    next: DLLNode<T> | null;
}
export declare class DoublyLinkedList<T> {
    head: DLLNode<T> | null;
    tail: DLLNode<T> | null;
    length: number;
    /** O(1) push to tail. */
    pushTail(node: DLLNode<T>): void;
    /** O(1) pop from head (FIFO fairness among idle nodes). */
    popHead(): DLLNode<T> | null;
    /** O(1) remove arbitrary node (requires direct handle). */
    remove(node: DLLNode<T>): void;
    clear(): void;
}
//# sourceMappingURL=doubly-linked-list.d.ts.map