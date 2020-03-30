/*
 * image-view.ts
 *
 * Copyright (C) 2019-20 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { Node as ProsemirrorNode } from 'prosemirror-model';
import { NodeView, EditorView } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';

import { EditorUI, ImageType } from '../../api/ui';
import { PandocExtensions, imageAttributesAvailable } from '../../api/pandoc';
import { isElementVisible } from '../../api/dom';
import { EditorEvents, EditorEvent } from '../../api/events';

import { imageDialog } from './image-dialog';
import {
  attachResizeUI,
  initResizeContainer,
  ResizeUI,
  isResizeUICompatible,
  updateImageViewSize,
} from './image-resize';
import { imageDimensionsFromImg, imageContainerWidth } from './image-util';

import './image-styles.css';


export class ImageNodeView implements NodeView {
  
  // ProseMirror context
  private readonly type: ImageType;
  private node: ProsemirrorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number;
  private readonly editorUI: EditorUI;
  private readonly imageAttributes: boolean;

  // DOM elements
  public readonly dom: HTMLElement;
  private readonly img: HTMLImageElement;
  public readonly contentDOM: HTMLElement | null;
  private readonly figcaption: HTMLElement | null;

  // transient state
  private imgBroken: boolean;
 
  // things to clean up
  private resizeUI: ResizeUI | null;
  private sizeOnVisibleTimer?: number;
  private unregisterOnResize: VoidFunction;

  constructor(
    node: ProsemirrorNode,
    view: EditorView,
    getPos: () => number,
    editorUI: EditorUI,
    editorEvents: EditorEvents,
    pandocExtensions: PandocExtensions,
  ) {
    // determine type
    const schema = node.type.schema;
    this.type = node.type === schema.nodes.image ? ImageType.Image : ImageType.Figure;

    // save references
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.imageAttributes = imageAttributesAvailable(pandocExtensions);
    this.editorUI = editorUI;
    this.resizeUI = null;
    this.imgBroken = false;

    // set node selection on click
    const selectOnClick = () => {
      const tr = view.state.tr;
      tr.setSelection(NodeSelection.create(view.state.doc, getPos()));
      view.dispatch(tr);
    };

    // show image dialog on double-click
    const editOnDblClick = () => {
      selectOnClick();
      imageDialog(
        this.node,
        imageDimensionsFromImg(this.img, this.containerWidth()),
        this.node.type,
        this.view,
        editorUI,
        this.imageAttributes,
      );
    };

    // stop propagation from child elmeents that need to handle click
    // (e.g. figcaption element)
    const noPropagateClick = (ev: MouseEvent) => {
      ev.stopPropagation();
    };

    // create the image (used by both image and figure node types)
    this.img = document.createElement('img');
    this.img.onload = () => {
      this.imgBroken = false;
    };
    this.img.onerror = () => {
      this.imgBroken = true;
    };
    this.img.onclick = selectOnClick;
    this.img.ondblclick = editOnDblClick;

    // wrap in figure if appropriate
    if (this.type === ImageType.Figure) {
      // create figure wrapper
      this.dom = document.createElement('figure');

      // create container
      const container = document.createElement('div');
      container.contentEditable = 'false';
      this.dom.append(container);

      // initialize the image
      container.append(this.img);
      this.updateImg();

      // create the caption and make it our contentDOM
      this.figcaption = document.createElement('figcaption');
      this.figcaption.classList.add('pm-figcaption');
      this.figcaption.classList.add('pm-node-caption');
      this.figcaption.onclick = noPropagateClick;
      this.figcaption.ondblclick = noPropagateClick;
      this.contentDOM = this.figcaption;
      this.dom.append(this.figcaption);

      // if there is no support for implicit_figures then hide the caption
      if (!pandocExtensions.implicit_figures) {
        this.figcaption.contentEditable = "false";
        this.figcaption.style.height = '0';
        this.figcaption.style.minHeight = '0';
        this.figcaption.style.margin = '0';
      }

      // standard inline image
    } else {
      this.dom = document.createElement('span');

      this.dom.append(this.img);
      this.updateImg();

      this.contentDOM = null;
      this.figcaption = null;
    }

    // prevent drag/drop if the event doesn't target the image
    this.dom.ondragstart = (event: DragEvent) => {
      if (event.target !== this.img) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // init resize if we support imageAttributes
    if (this.imageAttributes) {
      initResizeContainer(this.dom);
    }

    // update image size when the image first becomes visible
    this.updateSizeOnVisible();

    // update image size whenever the container is resized
    this.unregisterOnResize = editorEvents.subscribe(EditorEvent.Resize, () => {
      this.updateImageSize();
    });
  }

  public destroy() {
    this.unregisterOnResize();
    this.clearSizeOnVisibleTimer();
    this.detachResizeUI();
  }

  public selectNode() {
    // mirror default implementation
    this.dom.classList.add('ProseMirror-selectednode');
    if (this.contentDOM || !this.node.type.spec.draggable) {
      this.dom.draggable = true;
    }

    // attach resize UI
    this.attachResizeUI();
  }

  public deselectNode() {
    // mirror default implementation
    this.dom.classList.remove('ProseMirror-selectednode');
    if (this.contentDOM || !this.node.type.spec.draggable) {
      this.dom.draggable = false;
    }

    // remove resize UI
    this.detachResizeUI();
  }

  // update image with latest node/attributes
  public update(node: ProsemirrorNode) {
    // boilerplate type check
    if (node.type !== this.node.type) {
      return false;
    }

    // set new node and update the image
    this.node = node;
    this.updateImg();

    // if we already have resize UI then either update it
    // or detach it (if e.g. the units are no longer compatible)
    if (this.resizeUI) {
      if (isResizeUICompatible(this.img!)) {
        this.resizeUI.update();
      } else {
        this.resizeUI.detach();
        this.resizeUI = null;
      }
      // attach if the node is selected
    } else if (this.isNodeSelected()) {
      this.attachResizeUI();
    }
    return true;
  }

  // ignore mutations outside of the content dom so sizing actions don't cause PM re-render
  public ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Element }) {
    return !this.contentDOM || !this.contentDOM.contains(mutation.target);
  }

  // map node to img tag
  private updateImg() {

    // map to path reachable within current editing frame
    this.img.src = this.editorUI.context.mapResourcePath(this.node.attrs.src);

    // title/tooltip
    this.img.title = '';
    if (this.node.attrs.title) {
      this.img.title = this.node.attrs.title;
    } 

    // ensure alt attribute so that we get default browser broken image treatment
    this.img.alt = this.node.textContent || this.node.attrs.src;

    // update size
    this.updateImageSize();
  }

  private updateImageSize() {
     const containerWidth = this.img.isConnected ? this.containerWidth() : 0;
     updateImageViewSize(this.node, this.img, this.isFigure() ? this.dom : null, containerWidth);
  }

  private updateSizeOnVisible()
  {
    const updateSizeOnVisible = () => {
      if (isElementVisible(this.img)) {
        this.updateImageSize();
        this.clearSizeOnVisibleTimer();
      }
    }; 
    this.sizeOnVisibleTimer = window.setInterval(updateSizeOnVisible, 200);
  }

  private clearSizeOnVisibleTimer()
  {
    if (this.sizeOnVisibleTimer) {
      clearInterval(this.sizeOnVisibleTimer);
      this.sizeOnVisibleTimer = undefined;
    }
  }

  // attach resize UI if appropriate
  private attachResizeUI() {
    if (this.imageAttributes && !this.imgBroken && isResizeUICompatible(this.img!)) {
      const imageNode = () => ({ pos: this.getPos(), node: this.node });
      const imgContainerWidth = () => this.containerWidth();
      this.resizeUI = attachResizeUI(imageNode, this.dom, this.img!, imgContainerWidth, this.view, this.editorUI);
    }
  }

  private detachResizeUI() {
    if (this.resizeUI) {
      this.resizeUI.detach();
      this.resizeUI = null;
    }
  }

  private isNodeSelected() {
    return this.dom.classList.contains('ProseMirror-selectednode');
  }

  private isFigure() {
    return this.type === ImageType.Figure;
  }

  private containerWidth() {
    return imageContainerWidth(this.getPos(), this.view);
  }
}
