export class DoublyLinkedList {
    head = null;
    tail = null;
    length = 0;
    /** O(1) push to tail. */
    pushTail(node) {
        node.prev = this.tail;
        node.next = null;
        if (this.tail)
            this.tail.next = node;
        else
            this.head = node;
        this.tail = node;
        this.length++;
    }
    /** O(1) pop from head (FIFO fairness among idle nodes). */
    popHead() {
        const node = this.head;
        if (!node)
            return null;
        this.head = node.next;
        if (this.head)
            this.head.prev = null;
        else
            this.tail = null;
        node.prev = null;
        node.next = null;
        this.length--;
        return node;
    }
    /** O(1) remove arbitrary node (requires direct handle). */
    remove(node) {
        if (node.prev)
            node.prev.next = node.next;
        else
            this.head = node.next;
        if (node.next)
            node.next.prev = node.prev;
        else
            this.tail = node.prev;
        node.prev = null;
        node.next = null;
        this.length--;
    }
    clear() {
        this.head = null;
        this.tail = null;
        this.length = 0;
    }
}
//# sourceMappingURL=doubly-linked-list.js.map