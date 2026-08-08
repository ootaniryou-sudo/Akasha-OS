/**
 * Intrusive doubly-linked list node for O(1) idle-pool splice.
 * Nodes are pooled; never allocated on the dispatch hot path.
 */
export interface DLLNode<T> {
  value: T;
  prev: DLLNode<T> | null;
  next: DLLNode<T> | null;
}

export class DoublyLinkedList<T> {
  head: DLLNode<T> | null = null;
  tail: DLLNode<T> | null = null;
  length = 0;

  /** O(1) push to tail. */
  pushTail(node: DLLNode<T>): void {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.length++;
  }

  /** O(1) pop from head (FIFO fairness among idle nodes). */
  popHead(): DLLNode<T> | null {
    const node = this.head;
    if (!node) return null;
    this.head = node.next;
    if (this.head) this.head.prev = null;
    else this.tail = null;
    node.prev = null;
    node.next = null;
    this.length--;
    return node;
  }

  /** O(1) remove arbitrary node (requires direct handle). */
  remove(node: DLLNode<T>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
    this.length--;
  }

  clear(): void {
    this.head = null;
    this.tail = null;
    this.length = 0;
  }
}

