# Evacuation Management Application

A need to create an application to help coordinate evacuations and run routing algorithms to compute optimal routes for evacuees.

Since I am right now on the scoping stages of my project,I want to focus now on the User Interface (UI) of the application so that I can iterate concepts with the customer quickly.

/goal Your goal is to develop a user interface (UI) for an evacuation management application. The UI will be based on Open Street Maps (OSM) as the underlying map layer and source of information for roads, streets, etc. You will use simple routing algorithms over the OSM data to compute optimal routes for evacuees. Use the the web framework that you consider most appropriate for the application so that it integrates well with the OSM based frontend.

## Target Audience

The application will be used by emergency management personnel to coordinate evacuations and route evacuees. 

## UI Functionality

Through the UI the user will be able to:

1. Define evacuation **source areas**. A source area is a geographic area that is being evacuated and it is characterized by:

   - A name
   - A polygon defining the evacuation zone.
   - A population number to be evacuated.
   - A characterization of the population. We will initially consider three propulation types: 
     - random: people who take random paths to exit regardless the instructions of the authorities.
     - obedient: people who follow exactly the instructions of the authorities.
     - autonomous: people who make decisions on the fly based on what they see around them (e.g. traffic jams, etc) and will  seldomly follow the instructions of the authorities.

2. Define evacuation **target areas**. These are areas where the evacuation management personel decide that the evacuees should go. They are characterized by:

   - A name.
   - A polygon defining the target area.
   - A **capacity** which is the number of people the area can accomodate.

3. Define **no-go areas**. These are areas that cannot be used for evacuation. Each no-go area is defined by:

   - A name.
   - A polygon defining the no-go area.

4. Define the **evacuation vehicles** that are available to the authorities. Each evacuation vehicle is defined by:

   - A name.
   - A location where it is when the evacuation procedure starts.
   - A **capacity** which is the number of people it can accomodate.

5. Click on a button named "Compute evacuation routes" which will compute the evacuation routes for the evacuees. At this point, the application will use a routing algorithm (defined later) to compute the evacuation routes for the evacuees. Once computed the routes will be displayed on the map.

6. Click on a button named "Run simulation" which will run the simulation of the evacuation. At this point, the system will use a simulation algorithm (defined later) to run the simulation of the evacuation showing snapshots with an evolving heatmap showing where would the evacuees be at each snapshot.  The simulation will be run in an animation mode.

## UI Layout

The UI will have four areas

- A left side panel for defining the evacuation parameters. This panel will occupy 25% of the window width and the whole window heigh.  It will contain the following:
    - A list of source, target and no-go areas.
    - Buttons to add, modify and delete areas.
    - Areas will be defined by drawing polygons on the map. 
    - A list of available vehicles and their locations. 
    - Buttons to add, modify and delete vehicles.
    - Vehicles will be defined by points on the map. 
    - The button "Compute evacuation routes"
    - The button "Run simulation"
    - The button "Stop simulation"
    - The button "Reset simulation"
    - A dropdown list of preset scenarios containing 'Brussels' and 'Paris' 

- A right side panel, empty for the moment, occupyting 25% of the window width and the whole window height.

- A center area showing the OSM map, occupying the center 50% of the window width and top 75% of the window height.

- A bottom panel showing information and logs about the algorithm, sysmte, simulation, etc. occupying the center 50% of the window width and bottom 25% of the window height.

## Routing Algorithms

Use a simple routing algorithm to find shortest paths. Use OSRM for this purpose. You can find more information about OSRM at https://github.com/Project-OSRM/osrm-backend.

## Simulation

The simulation will show a heatmap overlay layer on top of the OSM map. The heatmap will show the density of evacuees at each point in time.  At the begining, all evacuees will be at their sources.  Then, step by step the evacuees will move towards their destinations following the routes computed by the routing algorithm.  At each step, the heatmap will be updated to show the new distribution of evacuees. The simulation will be run in an animation mode.

The simulation will also show the positions of the evacuation vehicles.

## Preset scenarios

For the Brussels preset scenario use the following parameters:
  - Source areas: 

  1. Grand Place with 1000 people
  2. Midi Station with 2000 people
  
  - Target areas: 

  1. Parc du Cinquantenaire with capacity for 50000 people
  2. Bruxelles Expo with capacity for 20000 people

  - No-go areas: 
    1. Ring of Brussels

  - Vehicles: 100 buses (occupancy 50) and 100 private cars (occupancy 4)

For the Paris present scenario use the following parameters:
  - Source areas: 
    1. Eiffel Tower with 1500 people
    2. Arc de Triomphe with 500 people
    
  - Target areas: 
    1. Parc de la Villette with capacity for 50000 people
    2. Parc de Bagatelle with capacity for 20000 people

  - No-go areas: 
    1. Pont D'Iena 
    2. Pont de l'Alma

  - Vehicles: 50 buses (occupancy 50)

