import { ID } from '@antv/graphlib';
import { debounce, throttle, uniq } from '@antv/util';
import { ComboModel, EdgeModel, NodeModel } from '../../types';
import { Behavior } from '../../types/behavior';
import { Point } from '../../types/common';
import { IG6GraphEvent } from '../../types/event';
import { graphComboTreeDfs } from '../../utils/data';
import { warn } from '../../utils/invariant';
import { isPointPreventPolylineOverlap, isPolylineWithObstacleAvoidance } from '../../utils/polyline';

const DELEGATE_SHAPE_ID = 'g6-drag-node-delegate-shape';

// TODO: Combo related features:
// onlyChangeComboSize
// comboActiveState
// comboStateStyles

export interface DragNodeOptions {
  /**
   * Whether to draw dragging nodes in transient layer.
   * Ignored when enableDelegate is true.
   * Defaults to true.
   */
  enableTransient?: boolean;
  /**
   * Whether to use a virtual rect moved with the dragging mouse instead of the node.
   * Defaults to false.
   */
  enableDelegate?: boolean;
  /**
   * The drawing properties when the nodes are dragged.
   * Only used when enableDelegate is true.
   */
  delegateStyle?: {
    fill?: string;
    stroke?: string;
    fillOpacity?: number;
    strokeOpacity?: number;
    lineWidth?: number;
    lineDash?: [number, number];
    [key: string]: unknown;
  };
  /**
   * The time in milliseconds to throttle moving. Useful to avoid the frequent calculation.
   * Defaults to 0.
   */
  throttle?: number;
  /**
   * Whether to hide the related edges to avoid calculation while dragging nodes.
   * Ignored when enableTransient or enableDelegate is true.
   * Defaults to false.
   */
  hideRelatedEdges?: boolean;
  /**
   * The state name to be considered as "selected".
   * Defaults to "selected".
   */
  selectedState?: string;
  /**
   * The event name to trigger when drag end.
   */
  eventName?: string;
  /**
   * Whether change the combo hierarchy structure or only change size.
   */
  updateComboStructure?: boolean;
  /**
   * Whether allow the behavior happen on the current item.
   */
  shouldBegin?: (event: IG6GraphEvent) => boolean;
}

const DEFAULT_OPTIONS: Required<DragNodeOptions> = {
  enableTransient: true,
  enableDelegate: false,
  delegateStyle: {
    fill: '#F3F9FF',
    fillOpacity: 0.5,
    stroke: '#1890FF',
    strokeOpacity: 0.9,
    lineDash: [5, 5],
  },
  throttle: 16,
  hideRelatedEdges: false,
  selectedState: 'selected',
  eventName: '',
  updateComboStructure: true,
  shouldBegin: () => true,
};

type Position = {
  id: ID;
  x: number;
  y: number;
  // The following fields only have values when delegate is enabled.
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
};

export class DragNode extends Behavior {
  // Private states
  private hiddenEdges: EdgeModel[] = [];
  private hiddenRelatedNodes: NodeModel[] = [];
  private selectedNodeIds: ID[] = [];
  private hiddenNearEdges: EdgeModel[] = [];
  private hiddenComboTreeItems: (ComboModel | NodeModel)[] = [];
  private originX: number;
  private originY: number;
  private originPositions: Array<Position> = [];
  private pointerDown: Point | undefined = undefined;
  private dragging = false;
  private hiddenNearEdgesCache: EdgeModel[] = [];
  private hiddenShapeCache: Map<ID, string[]> = new Map();

  constructor(options: Partial<DragNodeOptions>) {
    const finalOptions = Object.assign({}, DEFAULT_OPTIONS, options);
    if (finalOptions.enableDelegate) {
      finalOptions.enableTransient = false;
    }
    if (finalOptions.enableDelegate || finalOptions.enableTransient) {
      finalOptions.hideRelatedEdges = false;
    }
    super(finalOptions);
  }

  getEvents = () => {
    const events: any = {
      'node:pointerdown': this.onPointerDown,
      pointermove: this.onPointerMove,
      click: this.onClick,
      'node:pointerup': this.onPointerUp,
      // FIXME: IG6Event -> keyboard event
      keydown: this.onKeydown as any,
    };
    if (this.options.updateComboStructure) {
      return {
        'node:drop': this.onDropNode,
        'combo:drop': this.onDropCombo,
        'canvas:drop': this.onDropCanvas,
        ...events,
      };
    } else {
      return {
        pointerup: this.onClick,
        ...events,
      };
    }
  };

  /**
   * Given selected node ids, get their related visible edges.
   * @param selectedNodeIds
   * @param relatedCombo
   */
  private getRelatedEdges(selectedNodeIds: ID[], relatedCombo: (ComboModel | NodeModel)[]) {
    const relatedNodeComboIds = [];
    graphComboTreeDfs(this.graph, relatedCombo, (item) => relatedNodeComboIds.push(item.id));

    return uniq(
      selectedNodeIds.concat(relatedNodeComboIds).flatMap((nodeId) => this.graph.getRelatedEdgesData(nodeId)),
    );
  }

  private getRelatedNodes(selectedNodeIds: ID[]) {
    let relatedNodes = [];
    selectedNodeIds.forEach((id) => {
      const neighbors = this.graph
        .getNeighborNodesData(id, 'both')
        .filter((neighbor) => !selectedNodeIds.includes(neighbor.id));
      relatedNodes = relatedNodes.concat(neighbors);
    });
    return relatedNodes;
  }

  /**
   * Retrieve the nearby edges for a given node using quad-tree collision detection.
   * @param nodeIds
   * @param shouldBegin
   */
  private getNearEdgesForNodes(nodeIds: ID[], shouldBegin?: (edge: EdgeModel) => boolean) {
    return uniq(nodeIds.flatMap((nodeId) => this.graph.getNearEdgesData(nodeId, shouldBegin)));
  }

  private getComboTreeItems(selectedNodeIds: ID[]) {
    const ancestors = [];
    if (this.options.updateComboStructure) return ancestors;
    selectedNodeIds.forEach((id) => {
      const nodeData = this.graph.getNodeData(id);
      if (!nodeData.data.parentId) return;
      let parentId = nodeData.data.parentId;
      let ancestor;
      while (parentId) {
        const parentData = this.graph.getComboData(parentId);
        if (!parentData) break;
        ancestor = parentData;
        parentId = parentData.data.parentId;
        ancestors.push(ancestor);
      }
    });
    return uniq(ancestors).filter((item) => this.graph.getItemVisible(item.id));
  }

  public onPointerDown(event: IG6GraphEvent) {
    if (!this.options.shouldBegin(event)) return;
    this.pointerDown = { x: event.canvas.x, y: event.canvas.y };
    this.dragging = false;

    document.addEventListener(
      'mouseup',
      (evt) => {
        this.onPointerUp(event);
      },
      { once: true },
    );
  }

  public onPointerMove(event: IG6GraphEvent) {
    if (!this.pointerDown) return;

    const beginDeltaX = Math.abs(this.pointerDown.x - event.canvas.x);
    const beginDeltaY = Math.abs(this.pointerDown.y - event.canvas.y);
    if (beginDeltaX < 1 && beginDeltaY < 1) return;

    const enableTransient = this.options.enableTransient && this.graph.rendererType !== 'webgl-3d';

    // pointerDown + first move = dragging
    if (!this.dragging) {
      this.dragging = true;
      const currentNodeId = event.itemId;
      this.selectedNodeIds = this.graph.findIdByState('node', this.options.selectedState, true);

      // If current node is selected, drag all the selected nodes together.
      // Otherwise drag current node.
      if (currentNodeId && !this.selectedNodeIds.includes(currentNodeId)) {
        this.selectedNodeIds = [currentNodeId];
      }

      this.originPositions = this.selectedNodeIds
        .map((id) => {
          if (!this.graph.getNodeData(id)) {
            warn('node with id = "${id}" does not exist');
            return;
          }
          const { x, y } = this.graph.getNodeData(id).data as {
            x: number;
            y: number;
          };
          // If delegate is enabled, record bbox together.
          if (this.options.enableDelegate) {
            const bbox = this.graph.getRenderBBox(id);
            if (bbox) {
              const [minX, minY] = bbox.min;
              const [maxX, maxY] = bbox.max;
              return { id, x, y, minX, minY, maxX, maxY };
            }
          }
          return { id, x, y };
        })
        .filter(Boolean);

      // Hide related edge.
      if (this.options.hideRelatedEdges && !enableTransient) {
        this.hiddenComboTreeItems = this.getComboTreeItems(this.selectedNodeIds);
        this.hiddenEdges = this.getRelatedEdges(this.selectedNodeIds, this.hiddenComboTreeItems);
        this.hiddenRelatedNodes = this.getRelatedNodes(this.selectedNodeIds);
        const hiddenEdgeIds = this.hiddenEdges.map((edge) => edge.id);
        hiddenEdgeIds.forEach((edgeId) => {
          this.hiddenShapeCache.set(edgeId, this.graph.getItemVisibleShapeIds(edgeId));
        });
        this.graph.hideItem(hiddenEdgeIds, {
          disableAnimate: true,
        });
        const hiddenRelatedNodeIds = this.hiddenRelatedNodes.map((node) => node.id);
        hiddenRelatedNodeIds.forEach((nodeId) => {
          this.hiddenShapeCache.set(nodeId, this.graph.getItemVisibleShapeIds(nodeId));
        });
        this.graph.hideItem(hiddenRelatedNodeIds, {
          disableAnimate: true,
          keepRelated: true,
        });
        const hiddenComboTreeItemIds = this.hiddenComboTreeItems.map((child) => child.id);
        hiddenComboTreeItemIds.forEach((itemId) => {
          this.hiddenShapeCache.set(itemId, this.graph.getItemVisibleShapeIds(itemId));
        });
        this.graph.hideItem(
          this.hiddenComboTreeItems.map((child) => child.id),
          {
            disableAnimate: true,
          },
        );
      }

      // Draw transient nodes and edges.
      if (enableTransient) {
        // Draw transient edges and nodes.
        this.hiddenComboTreeItems = this.getComboTreeItems(this.selectedNodeIds);

        this.hiddenEdges = this.getRelatedEdges(this.selectedNodeIds, this.hiddenComboTreeItems);
        this.hiddenRelatedNodes = this.getRelatedNodes(this.selectedNodeIds);
        this.selectedNodeIds.forEach((nodeId) => {
          // draw the nodes' transients and their ancestor combos' transisents
          this.graph.drawTransient('node', nodeId, {
            upsertAncestors: !this.options.updateComboStructure,
          });
        });
        this.hiddenEdges.forEach((edge) => {
          this.graph.drawTransient('edge', edge.id, {});
        });

        // Hide original edges and nodes. They will be restored when pointerup.
        this.selectedNodeIds.forEach((itemId) => {
          this.hiddenShapeCache.set(itemId, this.graph.getItemVisibleShapeIds(itemId));
        });
        this.graph.hideItem(this.selectedNodeIds, { disableAnimate: true });

        const hiddenEdgeIds = this.hiddenEdges.map((edge) => edge.id);
        hiddenEdgeIds.forEach((itemId) => {
          this.hiddenShapeCache.set(itemId, this.graph.getItemVisibleShapeIds(itemId));
        });
        this.graph.hideItem(hiddenEdgeIds, { disableAnimate: true });
        const hiddenRelatedNodeIds = this.hiddenRelatedNodes.map((node) => node.id);
        hiddenRelatedNodeIds.forEach((itemId) => {
          this.hiddenShapeCache.set(itemId, this.graph.getItemVisibleShapeIds(itemId));
        });
        this.graph.hideItem(hiddenRelatedNodeIds, {
          disableAnimate: true,
          keepRelated: true,
        });
        const hiddenComboTreeItemIds = this.hiddenComboTreeItems.map((combo) => combo.id);
        hiddenComboTreeItemIds.forEach((itemId) => {
          this.hiddenShapeCache.set(itemId, this.graph.getItemVisibleShapeIds(itemId));
        });
        this.graph.hideItem(
          this.hiddenComboTreeItems.map((combo) => combo.id),
          { disableAnimate: true },
        );
      } else {
        this.graph.frontItem(this.selectedNodeIds);
      }

      // Throttle moving.
      if (this.options.throttle > 0) {
        this.throttledMoveNodes = throttle(this.moveNodes, this.options.throttle, { leading: true, trailing: true });
      } else {
        this.throttledMoveNodes = this.moveNodes;
      }

      this.originX = event.canvas.x;
      this.originY = event.canvas.y;
    }

    /**
     * When dragging nodes, if nodes are set to `preventPolylineEdgeOverlap`, identity nearby edges and dynamically update them
     */
    if (this.dragging && enableTransient) {
      const preventPolylineOverlapNodeIds = this.selectedNodeIds.filter((nodeId) => {
        const innerModel = this.graph.getNodeData(nodeId);
        return isPointPreventPolylineOverlap(innerModel);
      });

      if (preventPolylineOverlapNodeIds.length) {
        const hiddenEdgesIds = this.hiddenEdges.map((edge) => edge.id);
        this.hiddenNearEdgesCache = this.hiddenNearEdges;

        this.hiddenNearEdges = this.getNearEdgesForNodes(preventPolylineOverlapNodeIds, (edge) =>
          isPolylineWithObstacleAvoidance(edge),
        ).filter((edge) => !hiddenEdgesIds.includes(edge.id));
        const hiddenNearEdgesIds = this.hiddenNearEdges.map((edge) => edge.id);

        this.hiddenNearEdgesCache.forEach((edge) => {
          if (!hiddenNearEdgesIds.includes(edge.id)) {
            this.graph.drawTransient('edge', edge.id, { action: 'remove' });
            this.graph.showItem(edge.id);
          }
        });

        if (this.hiddenNearEdges.length) {
          this.hiddenNearEdges.forEach((edge) => {
            this.graph.drawTransient('edge', edge.id, {
              visible: true,
            });
          });

          const hiddenNearEdgeIds = this.hiddenNearEdges.map((edge) => edge.id);
          hiddenNearEdgeIds.forEach((itemId) => {
            this.hiddenShapeCache.set(itemId, this.graph.getItemVisibleShapeIds(itemId));
          });
          this.graph.hideItem(hiddenNearEdgeIds, { disableAnimate: true });
        }
      }
    }

    if (!this.originPositions.length || !this.dragging) {
      return;
    }

    // @ts-expect-error FIXME: type
    const pointerEvent = event as PointerEvent;
    // @ts-expect-error FIXME: Type
    const deltaX = pointerEvent.canvas.x - this.originX;
    // @ts-expect-error FIXME: Type
    const deltaY = pointerEvent.canvas.y - this.originY;

    if (this.options.enableDelegate) {
      this.moveDelegate(deltaX, deltaY);
    } else {
      const enableTransient = this.options.enableTransient && this.graph.rendererType !== 'webgl-3d';
      this.throttledMoveNodes(deltaX, deltaY, enableTransient, !this.options.updateComboStructure);
    }
  }

  public moveNodes(
    deltaX: number,
    deltaY: number,
    transient: boolean,
    upsertAncestors = true,
    callback?: (positions: Position[]) => void,
  ) {
    if (transient) {
      // Move transient nodes
      this.originPositions.forEach(({ id, x, y }) => {
        this.graph.drawTransient('node', id, {
          data: {
            x: x + deltaX,
            y: y + deltaY,
          },
          upsertAncestors,
        });
      });
      // Update transient edges.
      this.hiddenEdges.forEach((edge) => {
        this.graph.drawTransient('edge', edge.id, {});
      });
    } else {
      const positionChanges = this.originPositions.map(({ id, x, y }) => {
        return {
          id,
          data: {
            x: x + deltaX,
            y: y + deltaY,
          },
        };
      });
      const positions = [...this.originPositions];
      this.graph.updateNodePosition(positionChanges, upsertAncestors, true, () => callback?.(positions));
    }
  }

  public throttledMoveNodes: Function = (
    deltaX: number,
    deltaY: number,
    transient: boolean,
    upsertAncestors = true,
  ) => {
    // Should be overrided when drag start.
  };

  public moveDelegate(deltaX: number, deltaY: number) {
    const x1 = Math.min(...this.originPositions.map((position) => position.minX));
    const y1 = Math.min(...this.originPositions.map((position) => position.minY));
    const x2 = Math.max(...this.originPositions.map((position) => position.maxX));
    const y2 = Math.max(...this.originPositions.map((position) => position.maxY));
    this.graph.drawTransient('rect', DELEGATE_SHAPE_ID, {
      style: {
        x: x1 + deltaX,
        y: y1 + deltaY,
        width: x2 - x1,
        height: y2 - y1,
        ...this.options.delegateStyle,
      },
    });
  }

  public clearDelegate() {
    this.graph.drawTransient('rect', DELEGATE_SHAPE_ID, { action: 'remove' });
  }

  public clearTransientItems(positions: Array<Position>) {
    this.hiddenEdges.forEach((edge) => {
      this.graph.drawTransient('node', edge.source, { action: 'remove' });
      this.graph.drawTransient('node', edge.target, { action: 'remove' });
      this.graph.drawTransient('edge', edge.id, { action: 'remove' });
    });
    this.hiddenNearEdges.forEach((edge) => {
      this.graph.drawTransient('edge', edge.id, { action: 'remove' });
    });
    this.hiddenComboTreeItems.forEach((item) => {
      const isCombo = item.data._isCombo;
      this.graph.drawTransient(isCombo ? 'combo' : 'node', item.id, {
        action: 'remove',
      });
    });
    positions.forEach(({ id }) => {
      this.graph.drawTransient('node', id, { action: 'remove' });
    });
  }

  public restoreHiddenItems(positions?: Position[]) {
    if (this.hiddenEdges.length) {
      this.hiddenEdges.forEach((edge) => {
        this.graph.showItem(edge.id, {
          disableAnimate: true,
          shapeIds: this.hiddenShapeCache.get(edge.id),
        });
        this.hiddenShapeCache.delete(edge.id);
      });
      this.hiddenEdges = [];
    }
    if (this.hiddenRelatedNodes.length) {
      this.hiddenRelatedNodes.forEach((node) => {
        this.graph.showItem(node.id, {
          disableAnimate: true,
          shapeIds: this.hiddenShapeCache.get(node.id),
        });
        this.hiddenShapeCache.delete(node.id);
      });
      this.hiddenRelatedNodes = [];
    }
    if (this.hiddenNearEdges.length) {
      this.hiddenNearEdges.forEach((edge) => {
        this.graph.showItem(edge.id, { disableAnimate: true });
        this.hiddenShapeCache.delete(edge.id);
      });
      this.hiddenNearEdges = [];
    }
    if (this.hiddenComboTreeItems.length) {
      this.hiddenComboTreeItems.forEach((edge) => {
        this.graph.showItem(edge.id, {
          disableAnimate: true,
          shapeIds: this.hiddenShapeCache.get(edge.id),
        });
        this.hiddenShapeCache.delete(edge.id);
      });
      this.hiddenComboTreeItems = [];
    }
    const enableTransient = this.options.enableTransient && this.graph.rendererType !== 'webgl-3d';
    if (enableTransient) {
      this.originPositions.concat(positions).forEach((pos) => {
        this.graph.showItem(pos.id, {
          disableAnimate: true,
          shapeIds: this.hiddenShapeCache.get(pos.id),
        });
        this.hiddenShapeCache.delete(pos.id);
      });
    }
  }

  public clearState() {
    // Reset state.
    this.originPositions = [];
  }

  public onClick(event: IG6GraphEvent) {
    this.onPointerUp(event);
    this.clearState();
  }

  public onPointerUp(event: IG6GraphEvent) {
    this.pointerDown = undefined;
    this.dragging = false;
    this.selectedNodeIds = [];
    const enableTransient = this.options.enableTransient && this.graph.rendererType !== 'webgl-3d';
    // If transient or delegate was enabled, move the real nodes.
    // if (enableTransient || this.options.enableDelegate) {
    // @ts-expect-error FIXME: type
    const pointerEvent = event as PointerEvent;
    // @ts-expect-error FIXME: Type
    const deltaX = pointerEvent.canvas.x - this.originX + 0.01;
    // @ts-expect-error FIXME: Type
    const deltaY = pointerEvent.canvas.y - this.originY + 0.01;
    this.moveNodes(
      deltaX,
      deltaY,
      false,
      true,
      debounce((positions) => {
        // restore the hidden items after move real nodes done
        if (enableTransient) {
          this.clearTransientItems(positions);
        }

        if (this.options.enableDelegate) {
          this.clearDelegate();
        }

        // Restore all hidden items.
        // For all hideRelatedEdges, enableTransient and enableDelegate cases.
        this.restoreHiddenItems(positions);

        // Emit event.
        if (this.options.eventName) {
          this.graph.emit(this.options.eventName, {
            itemIds: positions.map((position) => position.id),
          });
        }

        // Reset state.
        this.clearState();
      }),
    );
  }

  // TODO: deal with combos
  public onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' && event.key !== 'Esc') {
      return;
    }
    this.clearDelegate();
    this.clearTransientItems(this.originPositions);
    this.restoreHiddenItems();

    const enableTransient = this.options.enableTransient && this.graph.rendererType !== 'webgl-3d';
    // Restore node positions.
    if (!enableTransient && !this.options.enableDelegate) {
      const positionChanges = this.originPositions.map(({ id, x, y }) => {
        return { id, data: { x, y } };
      });
      this.graph.updateNodePosition(positionChanges);
    }

    this.clearState();
  }

  public async onDropNode(event: IG6GraphEvent) {
    const elements = await this.graph.canvas.document.elementsFromPoint(event.canvas.x, event.canvas.y);
    const draggingIds = this.originPositions.map(({ id }) => id);
    const currentIds = elements
      // @ts-expect-error TODO: G type
      .map((ele) => ele.parentNode.getAttribute?.('data-item-id'))
      .filter((id) => id !== undefined && !draggingIds.includes(id));
    // the top item which is not in draggingIds
    const dropId = currentIds.find((id) => this.graph.getComboData(id) || this.graph.getNodeData(id));
    // drop on a node A, move the dragged node to the same parent of A
    const newParentId = this.graph.getNodeData(dropId) ? this.graph.getNodeData(dropId).data.parentId : dropId;

    this.originPositions.forEach(({ id }) => {
      const model = this.graph.getNodeData(id);
      if (!model) return;
      const { parentId } = model.data;
      // if the parents are same, do nothing
      if (parentId === newParentId) return;

      // update data to change the structure
      // if newParentId is undefined, new parent is the canvas
      this.graph.updateData('node', { id, data: { parentId: newParentId } });
    });
    this.onPointerUp(event);
  }

  public onDropCombo(event: IG6GraphEvent) {
    event.stopPropagation();
    const newParentId = event.itemId;

    this.onPointerUp(event);
    this.originPositions.forEach(({ id }) => {
      const model = this.graph.getNodeData(id);
      if (!model) return;
      const { parentId } = model.data;
      if (parentId === newParentId) return;
      this.graph.updateData('node', { id, data: { parentId: newParentId } });
    });
    this.clearState();
  }

  public async onDropCanvas(event: IG6GraphEvent) {
    const elements = await this.graph.canvas.document.elementsFromPoint(event.canvas.x, event.canvas.y);
    const draggingIds = this.originPositions.map(({ id }) => id);
    const currentIds = elements
      // @ts-expect-error TODO: G type
      .map((ele) => ele.parentNode.getAttribute?.('data-item-id'))
      .filter((id) => id !== undefined && !draggingIds.includes(id));
    // the top item which is not in draggingIds
    const dropId = currentIds.find((id) => this.graph.getComboData(id) || this.graph.getNodeData(id));
    const parentId = this.graph.getNodeData(dropId) ? this.graph.getNodeData(dropId).data.parentId : dropId;

    this.onPointerUp(event);
    const nodeToUpdate = [];
    this.originPositions.forEach(({ id }) => {
      const { parentId: originParentId } = this.graph.getNodeData(id).data;
      if (parentId && originParentId !== parentId) {
        nodeToUpdate.push({ id, data: { parentId } });
        return;
      }
      if (!originParentId) return;
      nodeToUpdate.push({ id, data: { parentId: undefined } });
    });
    if (nodeToUpdate.length) this.graph.updateData('node', nodeToUpdate);
    this.clearState();
  }
}
