# @fluid-example/spaces

**Spaces** is a Fluid component that provides a grid layout for users to compose their own experiences by adding and re-arranging components. This example explores how modular document types could work in Fluid.

## Getting Started

If you want to run this example follow the following steps:

1. Run `npm install` from the `FluidFramework` root directory
2. Start a Tinylicious server by following the instructions in [Tinylicious](../../../server/tinylicious)
3. On another terminal, navigate to this spaces directory
4. Run `npm run start` from this directory and open localhost:8080 on the browser to see the app running

## Components

The spaces package pulls in a collection of outside components and also has a few internal components that can be found at `./src/components`. The internal components simply offer more functionality for prototyping.

## Template

Template allows you to save and re-use a layout. When you click the `Template` button it will save the current layout. If you want to create a new document with the same layout add the `?template` to the url when creating a new doc.
